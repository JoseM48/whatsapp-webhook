'use strict';

const { isAllowlisted } = require('./security');

function selectWebhookRoute({
  phone,
  pmsEnabled,
  mvpEnabled,
  m0Enabled = false,
  quarantineAllowlist = [],
  pilotAllowlist = []
}) {
  const pilotActive = Boolean(pmsEnabled && mvpEnabled);
  const quarantinedPhone = isAllowlisted(phone, quarantineAllowlist);

  if (pmsEnabled && m0Enabled) {
    return { action: 'legacy', status: null, reason: 'm0_controlled_capture' };
  }

  if (quarantinedPhone && !pilotActive) {
    return {
      action: 'quarantine',
      status: 200,
      reason: 'pilot_disabled'
    };
  }

  if (pilotActive && isAllowlisted(phone, pilotAllowlist)) {
    return {
      action: 'pilot',
      status: null,
      reason: null
    };
  }

  return {
    action: 'legacy',
    status: null,
    reason: null
  };
}

module.exports = { selectWebhookRoute };
