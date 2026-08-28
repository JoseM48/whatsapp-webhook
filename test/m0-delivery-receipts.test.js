'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0DeliveryReceiptHandler } = require('../lib/pilot/m0-delivery-receipts');

const guest='573146892662',internal='573006774425';
const config={enabled:true,guestPhone:guest,internalPhone:internal,
  metaSignatureRequired:true,pmsConfigured:true};

test('reenvía cualquier teléfono con forma válida a PMS (autoridad real de correlación) y solo pone en cuarentena formas inválidas',async()=>{
  const calls=[];
  const handler=createM0DeliveryReceiptHandler({config,pms:{async recordClosedPilotDeliveryStatus(body){
    calls.push(body); return {matched:true,provider_status:body.status,delivery_status:body.status,reason_code:'APPLIED'};
  }},logger:{warn(){}}});
  const result=await handler.capture([
    {providerReference:'wamid.1',recipientId:internal,status:'delivered',timestamp:'2026-08-26T00:45:00.000Z',errorCode:null},
    // A real guest phone that is not the fixed configured one — must still be forwarded.
    {providerReference:'wamid.guest',recipientId:'573009998877',status:'sent',timestamp:'2026-08-26T00:45:00.500Z',errorCode:null},
    // Malformed/too-short recipient id — shape check quarantines this one.
    {providerReference:'wamid.bad',recipientId:'123',status:'failed',timestamp:'2026-08-26T00:45:01.000Z',errorCode:'131030'}
  ]);
  assert.equal(calls.length,2);
  assert.equal(result.processed,2);
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
