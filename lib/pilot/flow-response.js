'use strict';

// Duration option ids match the RadioButtonsGroup `data-source` ids declared
// in the Flow JSON asset (flows/m0-duration-flow.json) — keep both in sync.
const MONTHS_BY_DURATION_ID = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
const MAX_GUESTS = 4;

// The Flow branches into two mutually exclusive shapes (see the "then"/"else"
// of the If component in flows/m0-duration-flow.json):
//   - knows the checkout date: { checkin_date, checkout_date, guests }
//   - only knows a duration plan: { checkin_date, duration, guests }
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

  const guests = Number.parseInt(data?.guests, 10);
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) throw new Error('flow_response_guests_invalid');

  if (typeof data?.checkout_date === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.checkout_date)) throw new Error('flow_response_checkout_date_invalid');
    return { checkinDate, checkoutDate: data.checkout_date, guests };
  }

  const months = MONTHS_BY_DURATION_ID[data?.duration];
  if (!months) throw new Error('flow_response_duration_invalid');
  return { checkinDate, months, guests };
}

// A deliberately unambiguous sentence: ISO dates, "N meses" and "N personas"
// are all recognized by the deterministic date/duration/guests reader in
// lib/pilot/ai.js with certainty, regardless of what the model itself returns.
function flowResponseToText(parsed) {
  const guestsLabel = parsed.guests === 1 ? '1 persona' : `${parsed.guests} personas`;
  if (parsed.checkoutDate) {
    return `Del ${parsed.checkinDate} al ${parsed.checkoutDate}, ${guestsLabel}.`;
  }
  const label = parsed.months === 1 ? '1 mes' : `${parsed.months} meses`;
  return `Del ${parsed.checkinDate}, ${label}, ${guestsLabel}.`;
}

module.exports = { parseFlowResponse, flowResponseToText, MONTHS_BY_DURATION_ID };
