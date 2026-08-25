'use strict';

const crypto = require('crypto');

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').toUpperCase();
}

function attemptHash() {
  return crypto.randomBytes(32).toString('hex').toUpperCase();
}

function providerResultUnknown(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const httpStatus = Number(error?.response?.status || 0);
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'META_PROVIDER_REFERENCE_MISSING'].includes(code) ||
    message.includes('timeout') || httpStatus >= 500;
}

function failureCode(error) {
  const raw = String(error?.response?.data?.error?.code || error?.code || 'META_SEND_FAILED').toUpperCase();
  const safe = raw.replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
  return safe.length >= 3 ? safe : 'META_SEND_FAILED';
}

async function sendGovernedM0({ pms, interactionId, responseKind, response, recipient, sendText,
  observe = () => {}, logger = console }) {
  const authorization = await pms.authorizeM0Outbound({
    interaction_id: interactionId,
    response_kind: responseKind,
    response_hash: hashText(response),
    recipient_reference_hash: hashText(recipient)
  });
  observe('m0_outbound_authorized');
  if (authorization?.send_allowed !== true) {
    return { sent: authorization?.status === 'submitted', deduplicated: true,
      status: authorization?.status || 'not_authorized_for_send' };
  }
  const submissionAttemptHash = attemptHash();
  const begun = await pms.beginM0Outbound({ outbound_event_id: authorization.outbound_event_id,
    submission_attempt_hash: submissionAttemptHash });
  observe('m0_outbound_submission_started');
  if (begun?.send_allowed !== true) return { sent: false, deduplicated: true, status: begun?.status || 'not_started' };
  let providerReference;
  try {
    providerReference = await sendText(recipient, response);
    if (!providerReference) throw Object.assign(new Error('meta_provider_reference_missing'), { code: 'META_PROVIDER_REFERENCE_MISSING' });
  } catch (error) {
    try {
      if (providerResultUnknown(error)) {
        await pms.markM0OutboundUnknown({ outbound_event_id: authorization.outbound_event_id,
          submission_attempt_hash: submissionAttemptHash });
        observe('m0_outbound_submission_unknown');
        return { sent: false, deduplicated: false, status: 'submission_unknown' };
      }
      await pms.failM0Outbound({ outbound_event_id: authorization.outbound_event_id,
        submission_attempt_hash: submissionAttemptHash, failure_code: failureCode(error) });
      observe('m0_outbound_failed');
      return { sent: false, deduplicated: false, status: 'failed' };
    } catch (persistenceError) {
      logger.error('[m0-outbound] failure_persistence_failed', {
        code: persistenceError?.code || 'm0_outbound_failure_persistence_failed'
      });
      return { sent: false, deduplicated: false, status: 'reconciliation_required' };
    }
  }
  try {
    await pms.completeM0Outbound({ outbound_event_id: authorization.outbound_event_id,
      submission_attempt_hash: submissionAttemptHash, provider_reference: providerReference });
    observe('m0_outbound_submitted');
    return { sent: true, deduplicated: false, status: 'submitted', providerReference };
  } catch (error) {
    logger.error('[m0-outbound] completion_persistence_failed', {
      code: error?.code || 'm0_outbound_completion_persistence_failed'
    });
    observe('m0_outbound_reconciliation_required');
    return { sent: true, deduplicated: false, status: 'reconciliation_required', providerReference };
  }
}

module.exports = { sendGovernedM0, hashText, providerResultUnknown, failureCode };
