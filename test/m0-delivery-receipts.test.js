'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0DeliveryReceiptHandler } = require('../lib/pilot/m0-delivery-receipts');

const guest='573146892662',internal='573006774425';
const config={enabled:true,guestPhone:guest,internalPhone:internal,allowlist:[guest,internal],
  metaSignatureRequired:true,pmsConfigured:true};

test('persiste sólo recibos de los dos teléfonos y espera al PMS antes de completar',async()=>{
  const calls=[];
  const handler=createM0DeliveryReceiptHandler({config,pms:{async recordClosedPilotDeliveryStatus(body){
    calls.push(body); return {matched:true,provider_status:body.status,delivery_status:body.status,reason_code:'APPLIED'};
  }},logger:{warn(){}}});
  const result=await handler.capture([
    {providerReference:'wamid.1',recipientId:internal,status:'delivered',timestamp:'2026-08-26T00:45:00.000Z',errorCode:null},
    {providerReference:'wamid.third',recipientId:'573111111111',status:'failed',timestamp:'2026-08-26T00:45:01.000Z',errorCode:'131030'}
  ]);
  assert.equal(calls.length,1);
  assert.equal(result.processed,1);
  assert.equal(result.quarantined,1);
  assert.deepEqual(Object.keys(calls[0]).sort(),['error_code','occurred_at','provider_reference','recipient_id','status']);
});

test('un fallo PMS se propaga para que Meta reintente el webhook',async()=>{
  const handler=createM0DeliveryReceiptHandler({config,pms:{async recordClosedPilotDeliveryStatus(){
    throw Object.assign(new Error('offline'),{code:'ECONNRESET'});
  }}});
  await assert.rejects(()=>handler.capture([{providerReference:'wamid.1',recipientId:guest,status:'sent',
    timestamp:'2026-08-26T00:45:00.000Z',errorCode:null}]),/offline/);
});

test('la compuerta apagada no toca PMS',async()=>{
  let calls=0;
  const handler=createM0DeliveryReceiptHandler({config:{enabled:false},pms:{async recordClosedPilotDeliveryStatus(){calls+=1;}}});
  const result=await handler.capture([{providerReference:'wamid.1',recipientId:guest,status:'sent',
    timestamp:'2026-08-26T00:45:00.000Z',errorCode:null}]);
  assert.equal(calls,0); assert.equal(result.processed,0);
});
