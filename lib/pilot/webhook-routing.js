'use strict';

const { isAllowlisted } = require('./security');

function selectWebhookRoute({
  phone,
  pmsEnabled,
  mvpEnabled,
  quarantineAllowlist = [],
  pilotAllowlist = []
}) {
  const pilotActive = Boolean(pmsEnabled && mvpEnabled);
  const quarantinedPhone = isAllowlisted(phone, quarantineAllowlist);

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
