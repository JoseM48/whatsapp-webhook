'use strict';

const { isAllowlisted } = require('./security');

function resolvePmsIngress({ phone, allowlist = [], controlledEnabled = false, preferControlled = false }) {
  if (preferControlled === true && controlledEnabled === true) {
    return { allowed: true, mode: 'controlled_cohort', origin: 'whatsapp_oficial_controlled_ingress' };
  }
  if (isAllowlisted(phone, allowlist)) {
    return { allowed: true, mode: 'allowlist', origin: 'whatsapp_oficial_render_controlado' };
  }
  if (controlledEnabled === true) {
    return { allowed: true, mode: 'controlled_cohort', origin: 'whatsapp_oficial_controlled_ingress' };
  }
  return { allowed: false, mode: 'blocked', origin: null };
}

module.exports = { resolvePmsIngress };
