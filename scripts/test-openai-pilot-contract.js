'use strict';

require('dotenv').config();
const axios = require('axios');
const { PilotAi } = require('../lib/pilot/ai');

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('openai_api_key_missing');
  const ai = new PilotAi({
    http: axios,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.PILOT_OPENAI_MODEL || 'gpt-5.6-luna',
    safetySalt: 'synthetic-contract-test'
  });
  const interpreted = await ai.interpret({
    text: 'I need a studio from 2026-08-01 to 2026-08-05 for 2 guests with a balcony.',
    phone: 'synthetic-openai-contract',
    today: '2026-07-22'
  });
  if (interpreted._fallback) {
    console.error(JSON.stringify({ ok: false, stage: 'interpretation', fallback: true, dependency: interpreted._dependency }));
    process.exitCode = 1;
    return;
  }
  if (interpreted.language !== 'en' || interpreted.guests !== 2 || interpreted.check_in !== '2026-08-01') {
    throw new Error('openai_interpretation_contract_mismatch');
  }
  const presented = await ai.present({
    phone: 'synthetic-openai-contract',
    decision: {
      action: 'present', language: 'en', questions: [], escalation: null,
      alternatives: [{
        item_id: 1, public_title: 'Studio with balcony', summary: 'Private studio with a queen bed.',
        capacity: 2, attributes: { balcony: true }, tradeoffs: 'No air conditioning.',
        cover_media: { id: 10 }, availability_status: 'requires_operational_confirmation',
        price_status: 'requires_operational_confirmation'
      }],
      operational_check: { availability_confirmed: false, price_confirmed: false, status: 'requires_human_confirmation' },
      policy: { max_alternatives: 3, must_separate_offer_from_confirmation: true, no_booking_or_price_claims: true }
    }
  });
  if (presented._fallback) throw new Error('openai_presentation_used_fallback');
  if (!/availability/i.test(presented.text) || !/confirm/i.test(presented.text)) {
    throw new Error('openai_presentation_missing_confirmation_notice');
  }
  console.log(JSON.stringify({
    ok: true,
    model: process.env.PILOT_OPENAI_MODEL || 'gpt-5.6-luna',
    interpretation_contract: true,
    presentation_contract: true,
    store: false
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
