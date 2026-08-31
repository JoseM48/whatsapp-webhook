'use strict';

// Duration option ids match the RadioButtonsGroup `data-source` ids declared
// in the Flow JSON asset (flows/m0-duration-flow.json) — keep both in sync.
const MONTHS_BY_DURATION_ID = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };

function parseFlowResponse(responseJson) {
  if (!responseJson) throw new Error('flow_response_missing');
  let data;
  try {
    data = JSON.parse(responseJson);
  } catch {
    throw new Error('flow_response_invalid_json');
  }
  const checkinDate = typeof data?.checkin_date === 'string' ? data.checkin_date : null;
  if (!checkinDate || !/^\d{4}-\d{2}-\d{2}$/.test(checkinDate)) throw new Error('flow_response_checkin_date_invalid');
  const months = MONTHS_BY_DURATION_ID[data?.duration];
  if (!months) throw new Error('flow_response_duration_invalid');
  return { checkinDate, months };
}

// A deliberately unambiguous sentence: an ISO date and "N meses" are both
// recognized by the deterministic date/duration reader in lib/pilot/ai.js
// with certainty, regardless of what the model itself returns.
function flowResponseToText({ checkinDate, months }) {
  const label = months === 1 ? '1 mes' : `${months} meses`;
  return `Del ${checkinDate}, ${label}.`;
}

module.exports = { parseFlowResponse, flowResponseToText, MONTHS_BY_DURATION_ID };
