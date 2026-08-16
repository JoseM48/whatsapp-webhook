'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePmsIngress } = require('../lib/pilot/controlled-ingress');

test('conserva el allowlist como ruta prioritaria', () => {
  assert.deepEqual(resolvePmsIngress({phone:'573202882608',allowlist:['573202882608'],controlledEnabled:true}),{
    allowed:true,mode:'allowlist',origin:'whatsapp_oficial_render_controlado'
  });
});

test('admite candidatos de cohorte solo cuando la bandera está activa', () => {
  assert.deepEqual(resolvePmsIngress({phone:'573001112233',allowlist:[],controlledEnabled:false}),{
    allowed:false,mode:'blocked',origin:null
  });
  assert.deepEqual(resolvePmsIngress({phone:'573001112233',allowlist:[],controlledEnabled:true}),{
    allowed:true,mode:'controlled_cohort',origin:'whatsapp_oficial_controlled_ingress'
  });
});
