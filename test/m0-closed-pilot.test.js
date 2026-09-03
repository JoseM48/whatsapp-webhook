'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher, internalTemplateParameters, validateClosedPilotConfig } = require('../lib/pilot/m0-closed-pilot');

const guest='573146892662',internal='573006774425';
const config={enabled:true,guestPhone:guest,internalPhone:internal,metaSignatureRequired:true,
  pmsM0Enabled:true,controlledIngressEnabled:true,pmsConfigured:true,receiptsEnabled:true,
  internalTemplateName:'m0_internal_escalation_v1',internalTemplateLanguage:'es_CO'};

test('requires the internal phone and every immutable safety gate; the guest side is intentionally open',()=>{
  assert.throws(()=>validateClosedPilotConfig({...config,internalPhone:''}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,metaSignatureRequired:false}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,receiptsEnabled:false}),/m0_closed_webhook_configuration_invalid/);
  assert.throws(()=>validateClosedPilotConfig({...config,internalTemplateName:''}),/m0_closed_webhook_configuration_invalid/);
  assert.equal(validateClosedPilotConfig({enabled:false}).ready,false);
});

test('accepts any real phone as a guest and forwards it to PMS instead of quarantining locally',async()=>{
  let pmsCalls=0;
  const dispatcher=createM0ClosedPilotDispatcher({config,pms:{async closedPilotInbound(){pmsCalls+=1; return {outboxes:[]};}},
    async sendText(){}});
  assert.equal(dispatcher.accepts('573111111111'),true);
  const result=await dispatcher.process({phone:'573111111111',text:'hola',messageId:'wamid.third',occurredAt:new Date().toISOString()});
  assert.equal(result.quarantined,false);
  assert.equal(pmsCalls,1);
});

test('reserva comandos exactos para control y envía conversación comercial a lenguaje natural',()=>{
  const dispatcher=createM0ClosedPilotDispatcher({config,pms:{},async sendText(){}});
  assert.equal(dispatcher.isControl(guest,'NUEVA PRUEBA'),true);
  assert.equal(dispatcher.isControl(guest,'ESTADO CASO'),true);
  assert.equal(dispatcher.isControl(guest,'¿Tienen disponibilidad para septiembre?'),false);
  assert.equal(dispatcher.isControl(guest,'DISPONIBILIDAD 2026-09-10 2026-09-17 HUÉSPEDES 2 LF-210'),false);
  assert.equal(dispatcher.isControl(internal,'cualquier operación interna'),true);
  // A stranger typing the exact literal control phrase still resolves as
  // "control" — PMS is the one that rejects them (no enrolled lead), not the
  // webhook's routing layer. A stranger's ordinary conversation is not control.
  assert.equal(dispatcher.isControl('573111111111','NUEVA PRUEBA'),true);
  assert.equal(dispatcher.isControl('573111111111','hola, busco un apartamento'),false);
});

test('el flujo comercial contiene fallos de entrega después de la captura durable',async()=>{
  const completed=[];
  const pms={
    async beginClosedPilotCommercial(){return {processing_claimed:true,outboxes:[{id:30}]};},
    async claimClosedPilotOutbound(){return {outbox_id:30,claimable:true,recipient_kind:'guest',recipient_phone:guest,message_text:'acuse'};},
    async completeClosedPilotOutbound(body){completed.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){throw Object.assign(new Error('offline'),{code:'ECONNRESET'});},
    logger:{error(){}}});
  const result=await dispatcher.beginCommercial({phone:guest,messageId:'wamid.commercial.safe',occurredAt:new Date().toISOString()});
  assert.equal(result.result.processing_claimed,true);
  assert.equal(result.deliveries[0].sent,false);
  assert.equal(completed[0].status,'unknown');
});

test('delivers guest replies to the real phone behind that case, not a fixed configured one',async()=>{
  const otherGuest='573009998877';
  const calls=[],sent=[],templates=[];
  const pms={
    async closedPilotInbound(){return {case_key:'M0-1',state:'owner_pending',outboxes:[{id:10},{id:11}]};},
    async claimClosedPilotOutbound(id){return {outbox_id:id,claimable:true,status:'submitting',
      recipient_kind:id===10?'guest':'internal',recipient_phone:id===10?otherGuest:null,
      message_text:id===10?'guest body':
        'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: VALIDAR\n\nRevisar solicitud.'};},
    async completeClosedPilotOutbound(body){calls.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.guest';},
    async sendTemplate(phone,template){templates.push({phone,template});return 'wamid.internal';}});
  // otherGuest, not the configured guestPhone, is initiating this — proves the
  // reply routes to whoever the case actually belongs to.
  const result=await dispatcher.process({phone:otherGuest,text:'PRE-RESERVAR LF-210',messageId:'wamid.input',occurredAt:new Date().toISOString()});
  assert.deepEqual(sent.map((x)=>x.phone),[otherGuest]);
  assert.deepEqual(templates.map((x)=>x.phone),[internal]);
  assert.deepEqual(templates[0].template,{name:'m0_internal_escalation_v1',language:'es_CO',
    parameters:['PROPIETARIO','M0-1','LF-210','VALIDAR','Revisar solicitud.']});
  assert.deepEqual(calls.map((x)=>x.status),['submitted','submitted']);
  assert.equal(result.deliveries.every((x)=>x.sent),true);
});

test('a guest row marked message_kind:flow sends the calendar Flow, not plain text, when a Flow is configured',async()=>{
  const flowConfig={...config,flow:{enabled:true,flowId:'999888777',firstScreen:'CHECKIN_SCREEN'}};
  const sent=[],flows=[];
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:40}]};},
    async claimClosedPilotOutbound(){return {outbox_id:40,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_text:'¿Cuál es tu fecha de llegada?',message_kind:'flow'};},
    async completeClosedPilotOutbound(){}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config:flowConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},
    async sendFlow(phone,payload){flows.push({phone,payload});return 'wamid.flow';}});
  const result=await dispatcher.process({phone:guest,text:'x',messageId:'wamid.flow-in',occurredAt:new Date().toISOString()});
  assert.equal(sent.length,0);
  assert.equal(flows.length,1);
  assert.equal(flows[0].phone,guest);
  assert.deepEqual(flows[0].payload,{flowId:'999888777',flowToken:'40',firstScreen:'CHECKIN_SCREEN',
    ctaText:'Continuar',bodyText:'¿Cuál es tu fecha de llegada?'});
  assert.equal(result.deliveries[0].sent,true);
});

test('a proposal message (message_kind:text mentioning "LF-210: COP") sends the portada photo for each proposed apartment',async()=>{
  const sent=[],photos=[];
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:50}]};},
    async claimClosedPilotOutbound(){return {outbox_id:50,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',
      message_text:'Tengo estas opciones del 2026-09-15 al 2026-10-15 para 1 persona:\nLF-210: COP 3.300.000 total, anticipo COP 600.000\nLF-404: COP 3.300.000 total, anticipo COP 600.000\n\nResponde con el código.'};},
    async completeClosedPilotOutbound(){}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},
    async sendPhoto(phone,url){photos.push({phone,url});return 'wamid.photo';}});
  const result=await dispatcher.process({phone:guest,text:'x',messageId:'wamid.proposal-photos',occurredAt:new Date().toISOString()});
  assert.equal(sent.length,1);
  assert.deepEqual(photos.map((p)=>p.phone),[guest,guest]);
  assert.deepEqual(photos.map((p)=>p.url),[
    'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/01-portada.jpg',
    'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-404/01-portada.jpg'
  ]);
  assert.equal(result.deliveries[0].sent,true);
});

test('a message_kind:photos row sends the full gallery for the apartment it names, not just the portada',async()=>{
  const photos=[];
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:51}]};},
    async claimClosedPilotOutbound(){return {outbox_id:51,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'photos',message_text:'Aquí tienes más fotos de LF-210:'};},
    async completeClosedPilotOutbound(){}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(){return 'wamid.text';},
    async sendPhoto(phone,url){photos.push({phone,url});return 'wamid.photo';}});
  const result=await dispatcher.process({phone:guest,text:'x',messageId:'wamid.gallery',occurredAt:new Date().toISOString()});
  assert.equal(photos.length,6);
  assert.equal(photos.every((p)=>p.phone===guest),true);
  assert.equal(photos[0].url,'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/01-portada.jpg');
  assert.equal(photos[5].url,'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/06-tv.jpg');
  assert.equal(result.deliveries[0].sent,true);
});

test('a failed photo send never fails the outbox delivery -- the text message already went out',async()=>{
  const completed=[];
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:52}]};},
    async claimClosedPilotOutbound(){return {outbox_id:52,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:'LF-210: COP 3.300.000 total, anticipo COP 600.000'};},
    async completeClosedPilotOutbound(body){completed.push(body);}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(){return 'wamid.text';},
    async sendPhoto(){throw Object.assign(new Error('upstream'),{response:{status:500}});},
    logger:{error(){}}});
  const result=await dispatcher.process({phone:guest,text:'x',messageId:'wamid.photo-fail',occurredAt:new Date().toISOString()});
  assert.equal(result.deliveries[0].sent,true);
  assert.deepEqual(completed.map((c)=>c.status),['submitted']);
});

test('internal and Flow messages never trigger a photo send even when sendPhoto is configured',async()=>{
  const photos=[];
  const flowConfig={...config,flow:{enabled:true,flowId:'999888777',firstScreen:'CHECKIN_SCREEN'}};
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:53},{id:54}]};},
    async claimClosedPilotOutbound(id){return id===53
      ?{outbox_id:53,claimable:true,recipient_kind:'internal',recipient_phone:null,
        message_text:'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: VALIDAR\n\nLF-210: COP 1.'}
      :{outbox_id:54,claimable:true,recipient_kind:'guest',recipient_phone:guest,message_kind:'flow',
        message_text:'LF-210: COP 3.300.000 total, anticipo COP 600.000'};},
    async completeClosedPilotOutbound(){}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config:flowConfig,pms,
    async sendText(){return 'wamid.text';},
    async sendTemplate(){return 'wamid.internal';},
    async sendFlow(){return 'wamid.flow';},
    async sendPhoto(phone,url){photos.push({phone,url});return 'wamid.photo';}});
  await dispatcher.process({phone:guest,text:'x',messageId:'wamid.no-photo-leak',occurredAt:new Date().toISOString()});
  assert.equal(photos.length,0);
});

test('con restrictToTestPhones, sólo los teléfonos de prueba autorizados reciben el Flow; los demás caen a texto',async()=>{
  const restrictedConfig={...config,flow:{enabled:true,flowId:'999888777',firstScreen:'CHECKIN_SCREEN',
    restrictToTestPhones:true,testAllowlist:[guest]}};
  const otherGuest='573009998877';
  const sent=[],flows=[];
  const idByPhone={[guest]:40,[otherGuest]:41};
  const pms={
    async closedPilotInbound({phone}){return {outboxes:[{id:idByPhone[phone]}]};},
    async claimClosedPilotOutbound(id){const phone=id===40?guest:otherGuest;
      return {outbox_id:id,claimable:true,recipient_kind:'guest',recipient_phone:phone,
        message_text:'¿Cuál es tu fecha de llegada?',message_kind:'flow'};},
    async completeClosedPilotOutbound(){}
  };
  const dispatcher=createM0ClosedPilotDispatcher({config:restrictedConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},
    async sendFlow(phone,payload){flows.push({phone,payload});return 'wamid.flow';}});
  await dispatcher.process({phone:guest,text:'x',messageId:'wamid.restricted-authorized',occurredAt:new Date().toISOString()});
  await dispatcher.process({phone:otherGuest,text:'x',messageId:'wamid.restricted-unauthorized',occurredAt:new Date().toISOString()});
  assert.deepEqual(flows.map((x)=>x.phone),[guest]);
  assert.deepEqual(sent.map((x)=>x.phone),[otherGuest]);
});

test('a guest row marked message_kind:flow falls back to plain text when no Flow is configured yet',async()=>{
  const sent=[];
  const pms={
    async closedPilotInbound(){return {outboxes:[{id:41}]};},
    async claimClosedPilotOutbound(){return {outbox_id:41,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_text:'¿Cuál es tu fecha de llegada?',message_kind:'flow'};},
    async completeClosedPilotOutbound(){}
  };
  // No `flow` key in config at all — same as every dispatcher instantiated
  // before this feature existed.
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';}});
  const result=await dispatcher.process({phone:guest,text:'x',messageId:'wamid.flow-fallback',occurredAt:new Date().toISOString()});
  assert.deepEqual(sent,[{phone:guest,text:'¿Cuál es tu fecha de llegada?'}]);
  assert.equal(result.deliveries[0].sent,true);
});

test('a guest outbox item with no resolvable phone is rejected instead of silently misdelivered',async()=>{
  const pms={async closedPilotInbound(){return {outboxes:[{id:12}]};},
    async claimClosedPilotOutbound(){return {outbox_id:12,claimable:true,recipient_kind:'guest',recipient_phone:null,message_text:'x'};},
    async completeClosedPilotOutbound(){}};
  let textSends=0;
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){textSends+=1;},logger:{error(){}}});
  await assert.rejects(()=>dispatcher.process({phone:guest,text:'x',messageId:'wamid.no-phone',occurredAt:new Date().toISOString()}),
    /m0_closed_recipient_missing_or_invalid/);
  assert.equal(textSends,0);
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
    async claimClosedPilotOutbound(){return {outbox_id:20,claimable:true,recipient_kind:'guest',recipient_phone:guest,message_text:'x'};},
    async completeClosedPilotOutbound(body){completed.push(body);}};
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}});
  await assert.rejects(()=>dispatcher.process({phone:guest,text:'x',messageId:'wamid.timeout',occurredAt:new Date().toISOString()}),/timeout/);
  assert.equal(completed.length,1); assert.equal(completed[0].status,'unknown');
});

test('a Meta response without provider id remains unknown',async()=>{
  const completed=[];
  const pms={async closedPilotInbound(){return {outboxes:[{id:21}]};},
    async claimClosedPilotOutbound(){return {outbox_id:21,claimable:true,recipient_kind:'guest',recipient_phone:guest,message_text:'x'};},
    async completeClosedPilotOutbound(body){completed.push(body);}};
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,async sendText(){return null;}});
  await assert.rejects(()=>dispatcher.process({phone:guest,text:'x',messageId:'wamid.no-ref',occurredAt:new Date().toISOString()}),/provider_reference_missing/);
  assert.equal(completed[0].status,'unknown');
});

// Incremento D3.3 (2026-09-03): pruebas de la bandera/integración con
// PilotAi.redact() + el validador de D3.2, mockeando ambos -- sin llamadas
// reales a IA ni a pms-lite. completeCommercial() es el único camino que
// hace disponible authorized_response_packet a deliver() (ver
// m0-closed-pilot.service.js del lado pms-lite, D3.1); process()/
// beginCommercial() nunca lo tuvieron ni lo tienen ahora.

const naturalPacket={facts:[{topic:'parking',text:'Todos los apartamentos comercializados tienen parqueadero.'}],
  numbers:[],dates:[],apartments:[],action:'RESPONDER INFORMACIÓN APROBADA',components:['knowledge'],
  pending:[],required_disclosures:[],forbidden_claims:[],questions_to_ask:[],knowledge_sources:[],
  ui:{message_kind:'text',photo_target_codes:[]},
  deterministic_text:'Todos los apartamentos comercializados tienen parqueadero.',presentation_source:'deterministic'};

test('D3.3: bandera OFF (default) -- completeCommercial envía deterministic_text sin llamar a redact(), aunque haya packet y redactionAi',async()=>{
  const sent=[];
  let redactCalls=0;
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:60}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:60,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:naturalPacket.deterministic_text};},
    async completeClosedPilotOutbound(){}
  };
  const redactionAi={async redact(){redactCalls+=1; return {text:'no debería usarse',model:'gpt-5.6-luna',latency_ms:1};}};
  // config sin naturalPresentationEnabled -- mismo config base que el resto del archivo.
  const dispatcher=createM0ClosedPilotDispatcher({config,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},redactionAi});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-off',interpretation:{},ai:{}});
  assert.equal(redactCalls,0);
  assert.deepEqual(sent,[{phone:guest,text:naturalPacket.deterministic_text}]);
});

test('D3.3: bandera ON + candidato válido -- se envía el texto redactado por IA, validado, en vez del determinístico',async()=>{
  const sent=[];
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:61}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:61,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:naturalPacket.deterministic_text};},
    async completeClosedPilotOutbound(){},
    async validateAuthorizedResponse(){return {valid:true,failure_reasons:[],meta:{}};}
  };
  const redactionAi={async redact(){return {text:'¡Claro! Todos cuentan con parqueadero.',model:'gpt-5.6-luna',latency_ms:400};}};
  const onConfig={...config,naturalPresentationEnabled:true};
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},redactionAi});
  const result=await dispatcher.completeCommercial({externalMessageId:'wamid.d33-on-valid',interpretation:{},ai:{}});
  assert.deepEqual(sent,[{phone:guest,text:'¡Claro! Todos cuentan con parqueadero.'}]);
  assert.equal(result.deliveries[0].sent,true);
});

test('D3.3: bandera ON + candidato inválido -- se descarta por completo y se envía deterministic_text',async()=>{
  const sent=[];
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:62}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:62,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:naturalPacket.deterministic_text};},
    async completeClosedPilotOutbound(){},
    async validateAuthorizedResponse(){return {valid:false,failure_reasons:['forbidden_claim:excepcion_aprobada'],meta:{}};}
  };
  const redactionAi={async redact(){return {text:'Listo, te hago el descuento.',model:'gpt-5.6-luna',latency_ms:350};}};
  const onConfig={...config,naturalPresentationEnabled:true};
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},redactionAi});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-on-invalid',interpretation:{},ai:{}});
  assert.deepEqual(sent,[{phone:guest,text:naturalPacket.deterministic_text}]);
});

test('D3.3: bandera ON pero sin packet para este turno -- se comporta como determinístico, sin llamar a redact()',async()=>{
  const sent=[];
  let redactCalls=0;
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:63}],authorized_response_packet:null};},
    async claimClosedPilotOutbound(){return {outbox_id:63,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:'Recibí tu mensaje.'};},
    async completeClosedPilotOutbound(){}
  };
  const redactionAi={async redact(){redactCalls+=1; return {text:'x',model:'m',latency_ms:1};}};
  const onConfig={...config,naturalPresentationEnabled:true};
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';},redactionAi});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-no-packet',interpretation:{},ai:{}});
  assert.equal(redactCalls,0);
  assert.deepEqual(sent,[{phone:guest,text:'Recibí tu mensaje.'}]);
});

test('D3.3: bandera ON pero sin redactionAi configurado -- se comporta como determinístico',async()=>{
  const sent=[];
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:64}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:64,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'text',message_text:naturalPacket.deterministic_text};},
    async completeClosedPilotOutbound(){}
  };
  const onConfig={...config,naturalPresentationEnabled:true};
  // Sin `redactionAi` en absoluto -- mismo dispatcher que ya usa el resto del archivo.
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendText(phone,text){sent.push({phone,text});return 'wamid.text';}});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-no-ai',interpretation:{},ai:{}});
  assert.deepEqual(sent,[{phone:guest,text:naturalPacket.deterministic_text}]);
});

test('D3.3: un mensaje interno nunca pasa por redacción, incluso con la bandera ON y un packet disponible',async()=>{
  const templates=[];
  let redactCalls=0;
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:65}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:65,claimable:true,recipient_kind:'internal',recipient_phone:null,
      message_text:'PILOTO M0\nPARA: ADMINISTRACIÓN\nCASO: M0-9\nAPARTAMENTO: PENDIENTE\nACCIÓN SOLICITADA: VALIDAR\n\nDetalle.'};},
    async completeClosedPilotOutbound(){}
  };
  const redactionAi={async redact(){redactCalls+=1; return {text:'x',model:'m',latency_ms:1};}};
  const onConfig={...config,naturalPresentationEnabled:true};
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendTemplate(phone,template){templates.push(template);return 'wamid.internal';},redactionAi});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-internal',interpretation:{},ai:{}});
  assert.equal(redactCalls,0);
  assert.equal(templates.length,1);
});

test('D3.3: una fila message_kind:photos nunca pasa por redacción',async()=>{
  let redactCalls=0;
  const pms={
    async processClosedPilotCommercial(){return {outboxes:[{id:66}],authorized_response_packet:naturalPacket};},
    async claimClosedPilotOutbound(){return {outbox_id:66,claimable:true,recipient_kind:'guest',recipient_phone:guest,
      message_kind:'photos',message_text:'Aquí tienes más fotos de LF-210:'};},
    async completeClosedPilotOutbound(){}
  };
  const redactionAi={async redact(){redactCalls+=1; return {text:'x',model:'m',latency_ms:1};}};
  const onConfig={...config,naturalPresentationEnabled:true};
  const dispatcher=createM0ClosedPilotDispatcher({config:onConfig,pms,
    async sendText(){return 'wamid.text';},async sendPhoto(){return 'wamid.photo';},redactionAi});
  await dispatcher.completeCommercial({externalMessageId:'wamid.d33-photos',interpretation:{},ai:{}});
  assert.equal(redactCalls,0);
});

test('flattens a multi-line internal body into a single line so Meta never rejects the template',()=>{
  const body='PILOTO M0\nPARA: ADMINISTRACIÓN\nCASO: M0-3\nAPARTAMENTO: PENDIENTE\nACCIÓN SOLICITADA: VALIDAR BRECHA DE CONOCIMIENTO\n\n'+
    'PREGUNTA DEL HUÉSPED: ¿Desde cuándo tienes disponibilidad?\nTEMAS DETECTADOS: other.\nINSTRUCCIÓN: Validar y responder únicamente con información aprobada.';
  const parameters=internalTemplateParameters(body);
  assert.equal(parameters.length,5);
  for(const value of parameters) {
    assert.doesNotMatch(value,/[\r\n\t]/);
    assert.doesNotMatch(value,/ {2,}/);
  }
  assert.equal(parameters[4],'PREGUNTA DEL HUÉSPED: ¿Desde cuándo tienes disponibilidad? TEMAS DETECTADOS: other. '+
    'INSTRUCCIÓN: Validar y responder únicamente con información aprobada.');
});
