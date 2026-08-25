'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher, validateClosedPilotConfig } = require('../lib/pilot/m0-closed-pilot');

const guest='573146892662',internal='573006774425';
const config={enabled:true,guestPhone:guest,internalPhone:internal,allowlist:[guest,internal],metaSignatureRequired:true,
  pmsM0Enabled:true,controlledIngressEnabled:true,pmsConfigured:true};

test('requires the exact two phones and every immutable safety gate',()=>{
  assert.throws(()=>validateClosedPilotConfig({...config,allowlist:[guest,internal,'573111111111']}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,metaSignatureRequired:false}),/m0_closed_webhook_configuration_invalid/);
  assert.equal(validateClosedPilotConfig({enabled:false}).ready,false);
});

test('quarantines every third party without calling PMS or Meta',async()=>{
  let pmsCalls=0,sends=0;
  const dispatcher=createM0ClosedPilotDispatcher({config,pms:{async closedPilotInbound(){pmsCalls+=1;}},
    async sendText(){sends+=1;}});
  const result=await dispatcher.process({phone:'573111111111',text:'hola',messageId:'wamid.third',occurredAt:new Date().toISOString()});
  assert.equal(result.quarantined,true); assert.equal(pmsCalls,0); assert.equal(sends,0);
});

test('delivers only claimed durable outboxes to the bound phone and completes them',async()=>{
  const calls=[],sent=[];
  const pms={
    async closedPilotInbound(){return {case_key:'M0-1',state:'owner_pending',outboxes:[{id:10},{id:11}]};},
    async claimClosedPilotOutbound(id){return {outbox_id:id,claimable:true,status:'submitting',
      recipient_kind:id===10?'guest':'internal',message_text:id===10?'guest body':'PILOTO M0\nPARA: PROPIETARIO'};},
    async completeClosedPilotOutbound(body){calls.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(phone,text){sent.push({phone,text});return `wamid.${sent.length}`;}});
  const result=await dispatcher.process({phone:guest,text:'PRE-RESERVAR LF-210',messageId:'wamid.input',occurredAt:new Date().toISOString()});
  assert.deepEqual(sent.map((x)=>x.phone),[guest,internal]);
  assert.deepEqual(calls.map((x)=>x.status),['submitted','submitted']);
  assert.equal(result.deliveries.every((x)=>x.sent),true);
});

test('marks uncertain sends unknown and never retries them automatically',async()=>{
  const completed=[];
  const pms={async closedPilotInbound(){return {outboxes:[{id:20}]};},
    async claimClosedPilotOutbound(){return {outbox_id:20,claimable:true,recipient_kind:'guest',message_text:'x'};},
    async completeClosedPilotOutbound(body){completed.push(body);}};
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}});
  await assert.rejects(()=>dispatcher.process({phone:guest,text:'x',messageId:'wamid.timeout',occurredAt:new Date().toISOString()}),/timeout/);
  assert.equal(completed.length,1); assert.equal(completed[0].status,'unknown');
});

test('a Meta response without provider id remains unknown',async()=>{
  const completed=[];
  const pms={async closedPilotInbound(){return {outboxes:[{id:21}]};},
    async claimClosedPilotOutbound(){return {outbox_id:21,claimable:true,recipient_kind:'guest',message_text:'x'};},
    async completeClosedPilotOutbound(body){completed.push(body);}};
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){return null;}});
  await assert.rejects(()=>dispatcher.process({phone:guest,text:'x',messageId:'wamid.no-ref',occurredAt:new Date().toISOString()}),/provider_reference_missing/);
  assert.equal(completed[0].status,'unknown');
});
