'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher, validateClosedPilotConfig } = require('../lib/pilot/m0-closed-pilot');

const guest='573146892662',internal='573006774425';
const config={enabled:true,guestPhone:guest,internalPhone:internal,allowlist:[guest,internal],metaSignatureRequired:true,
  pmsM0Enabled:true,controlledIngressEnabled:true,pmsConfigured:true,receiptsEnabled:true,
  internalTemplateName:'m0_internal_escalation_v1',internalTemplateLanguage:'es_CO'};

test('requires the exact two phones and every immutable safety gate',()=>{
  assert.throws(()=>validateClosedPilotConfig({...config,allowlist:[guest,internal,'573111111111']}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,metaSignatureRequired:false}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,receiptsEnabled:false}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,internalTemplateName:''}),/m0_closed_webhook_configuration_invalid/);
  assert.equal(validateClosedPilotConfig({enabled:false}).ready,false);
});

test('quarantines every third party without calling PMS or Meta',async()=>{
  let pmsCalls=0,sends=0;
  const dispatcher=createM0ClosedPilotDispatcher({config,pms:{async closedPilotInbound(){pmsCalls+=1;}},
    async sendText(){sends+=1;}});
  const result=await dispatcher.process({phone:'573111111111',text:'hola',messageId:'wamid.third',occurredAt:new Date().toISOString()});
  assert.equal(result.quarantined,true); assert.equal(pmsCalls,0); assert.equal(sends,0);
});

test('reserva comandos exactos para control y envía conversación comercial a lenguaje natural',()=>{
  const dispatcher=createM0ClosedPilotDispatcher({config,pms:{},async sendText(){}});
  assert.equal(dispatcher.isControl(guest,'NUEVA PRUEBA'),true);
  assert.equal(dispatcher.isControl(guest,'ESTADO CASO'),true);
  assert.equal(dispatcher.isControl(guest,'¿Tienen disponibilidad para septiembre?'),false);
  assert.equal(dispatcher.isControl(guest,'DISPONIBILIDAD 2026-09-10 2026-09-17 HUÉSPEDES 2 LF-210'),false);
  assert.equal(dispatcher.isControl(internal,'cualquier operación interna'),true);
  assert.equal(dispatcher.isControl('573111111111','NUEVA PRUEBA'),false);
});

test('el flujo comercial contiene fallos de entrega después de la captura durable',async()=>{
  const completed=[];
  const pms={
    async beginClosedPilotCommercial(){return {processing_claimed:true,outboxes:[{id:30}]};},
    async claimClosedPilotOutbound(){return {outbox_id:30,claimable:true,recipient_kind:'guest',message_text:'acuse'};},
    async completeClosedPilotOutbound(body){completed.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){throw Object.assign(new Error('offline'),{code:'ECONNRESET'});},
    logger:{error(){}}});
  const result=await dispatcher.beginCommercial({phone:guest,messageId:'wamid.commercial.safe',occurredAt:new Date().toISOString()});
  assert.equal(result.result.processing_claimed,true);
  assert.equal(result.deliveries[0].sent,false);
  assert.equal(completed[0].status,'unknown');
});

test('delivers only claimed durable outboxes to the bound phone and completes them',async()=>{
  const calls=[],sent=[],templates=[];
  const pms={
    async closedPilotInbound(){return {case_key:'M0-1',state:'owner_pending',outboxes:[{id:10},{id:11}]};},
    async claimClosedPilotOutbound(id){return {outbox_id:id,claimable:true,status:'submitting',
      recipient_kind:id===10?'guest':'internal',message_text:id===10?'guest body':
        'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: VALIDAR\n\nRevisar solicitud.'};},
    async completeClosedPilotOutbound(body){calls.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.guest';},
    async sendTemplate(phone,template){templates.push({phone,template});return 'wamid.internal';}});
  const result=await dispatcher.process({phone:guest,text:'PRE-RESERVAR LF-210',messageId:'wamid.input',occurredAt:new Date().toISOString()});
  assert.deepEqual(sent.map((x)=>x.phone),[guest]);
  assert.deepEqual(templates.map((x)=>x.phone),[internal]);
  assert.deepEqual(templates[0].template,{name:'m0_internal_escalation_v1',language:'es_CO',
    parameters:['PROPIETARIO','M0-1','LF-210','VALIDAR','Revisar solicitud.']});
  assert.deepEqual(calls.map((x)=>x.status),['submitted','submitted']);
  assert.equal(result.deliveries.every((x)=>x.sent),true);
});

test('an internal escalation can never fall back to free-form text',async()=>{
  let textSends=0;
  const pms={async closedPilotInbound(){return {outboxes:[{id:31}]};},
    async claimClosedPilotOutbound(){return {outbox_id:31,claimable:true,recipient_kind:'internal',
      message_text:'PILOTO M0\nPARA: ADMINISTRACIÓN\nCASO: M0-2\nAPARTAMENTO: LF-404\nACCIÓN SOLICITADA: REVISAR\n\nDetalle.'};},
    async completeClosedPilotOutbound(){}};
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){textSends+=1;},
    async sendTemplate(){return 'wamid.template';}});
  await dispatcher.process({phone:guest,text:'x',messageId:'wamid.template-only',occurredAt:new Date().toISOString()});
  assert.equal(textSends,0);
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
