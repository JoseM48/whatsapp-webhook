'use strict';

const { safetyIdentifier } = require('./security');

const interpretationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['lodging_search', 'lodging_question', 'greeting', 'other', 'unknown'] },
    language: { type: 'string', enum: ['es', 'en'] },
    check_in: { type: ['string', 'null'], format: 'date' },
    check_out: { type: ['string', 'null'], format: 'date' },
    nights: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
    guests: { type: ['integer', 'null'], minimum: 1, maximum: 20 },
    preferences: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    requirements: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    uncertainty: { type: 'number', minimum: 0, maximum: 1 },
    needs_clarification: { type: 'boolean' },
    missing_fields: { type: 'array', items: { type: 'string', enum: ['check_in', 'check_out_or_nights', 'guests'] } }
  },
  required: ['intent', 'language', 'check_in', 'check_out', 'nights', 'guests', 'preferences', 'requirements', 'uncertainty', 'needs_clarification', 'missing_fields']
};

const presentationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 2500 },
    selected_item_ids: { type: 'array', items: { type: ['integer', 'string'] }, maxItems: 3 },
    selected_media_ids: { type: 'array', items: { type: ['integer', 'string'] }, maxItems: 3 }
  },
  required: ['text', 'selected_item_ids', 'selected_media_ids']
};

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') return content.text;
    }
  }
  throw new Error('openai_output_text_missing');
}

function safeDependencyError(error) {
  return {
    status: Number(error?.response?.status) || null,
    code: String(error?.response?.data?.error?.code || error?.code || 'openai_request_failed')
      .replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 100),
    type: String(error?.response?.data?.error?.type || 'unknown')
      .replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 100)
  };
}

function detectLanguage(text) {
  return /\b(hello|hi|guests?|nights?|check[ -]?in|balcony|apartment)\b/i.test(text) ? 'en' : 'es';
}

function minimizeUserText(text) {
  return String(text || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, '[phone-redacted]')
    .slice(0, 1500);
}

function findNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function deterministicInterpret(text) {
  const dates = String(text).match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  const nights = findNumber(text, [/(\d+)\s*(?:noches?|nights?)/i]);
  const guests = findNumber(text, [/(\d+)\s*(?:personas?|hu[eé]spedes?|guests?|people)/i, /(?:somos|para)\s+(\d+)/i]);
  const preferences = [];
  const requirements = [];
  const add = (pattern, value) => { if (pattern.test(text)) preferences.push(value); };
  add(/balc[oó]n|balcony/i, 'balcony');
  add(/aire acondicionado|air conditioning|\bAC\b/i, 'air_conditioning');
  add(/sof[aá] cama|sofa bed/i, 'sofa_bed');
  add(/lavadora|laundry/i, 'private_laundry');
  add(/vista|view/i, 'panoramic_view');
  if (/necesito|indispensable|must have|required/i.test(text)) requirements.push(...preferences);
  const missing = [];
  if (!dates[0]) missing.push('check_in');
  if (!dates[1] && !nights) missing.push('check_out_or_nights');
  if (!guests) missing.push('guests');
  return {
    intent: /hola|hello|\bhi\b/i.test(text) && text.trim().split(/\s+/).length < 4 ? 'greeting' : 'lodging_search',
    language: detectLanguage(text), check_in: dates[0] || null, check_out: dates[1] || null,
    nights, guests, preferences: [...new Set(preferences)], requirements: [...new Set(requirements)],
    uncertainty: missing.length ? 0.45 : 0.15, needs_clarification: missing.length > 0, missing_fields: missing
  };
}

function deterministicPresentation(decision) {
  if (decision.presentation_contract) {
    return {
      text: decision.presentation_contract.text,
      selected_item_ids: decision.presentation_contract.selected_item_ids || [],
      selected_media_ids: decision.presentation_contract.selected_media_ids || []
    };
  }
  const language = decision.language || 'es';
  if (decision.action === 'clarify') {
    return { text: decision.questions.map((item) => item.question).join('\n'), selected_item_ids: [], selected_media_ids: [] };
  }
  if (decision.action === 'escalate') {
    return {
      text: language === 'en'
        ? 'I could not find a compatible approved option. I will ask the Reservations team to review your request.'
        : 'No encontré una opción aprobada compatible. Pediré al equipo de Reservas que revise tu solicitud.',
      selected_item_ids: [], selected_media_ids: []
    };
  }
  const lines = decision.alternatives.map((item, index) => `${index + 1}. ${item.public_title}: ${item.summary}`);
  const notice = language === 'en'
    ? 'These are commercial options; availability and price require confirmation from the Reservations team.'
    : 'Estas son alternativas comerciales; la disponibilidad y el precio requieren confirmación del equipo de Reservas.';
  return {
    text: `${lines.join('\n')}\n\n${notice}`,
    selected_item_ids: decision.alternatives.map((item) => item.item_id),
    selected_media_ids: decision.alternatives.map((item) => item.cover_media?.id).filter(Boolean)
  };
}

function sameIds(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => String(value) === String(right[index]));
}

class PilotAi {
  constructor({ http, apiKey, model = 'gpt-5.6-luna', safetySalt = '' }) {
    this.http = http; this.apiKey = apiKey; this.model = model; this.safetySalt = safetySalt;
  }

  async structured({ name, schema, system, input, phone }) {
    if (!this.apiKey) throw new Error('openai_api_key_missing');
    const response = await this.http.post('https://api.openai.com/v1/responses', {
      model: this.model,
      store: false,
      reasoning: { effort: 'low' },
      safety_identifier: safetyIdentifier(phone, this.safetySalt),
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: input }] }
      ],
      text: { format: { type: 'json_schema', name, strict: true, schema } }
    }, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000
    });
    return JSON.parse(outputText(response.data));
  }

  async interpret({ text, phone, today }) {
    try {
      return await this.structured({
        name: 'pilot_interpretation', schema: interpretationSchema, phone,
        system: 'Extract only the requested lodging-search fields. Do not infer missing dates, guests, price, availability, booking, identity, or sensitive data. Use ISO dates. Preferences are desirable; requirements are mandatory only when the user clearly says so.',
        input: `Current date in America/Bogota: ${today}. Customer message:\n${minimizeUserText(text)}`
      });
    } catch (error) {
      return {
        ...deterministicInterpret(text), _fallback: true, _error_code: 'ai_interpretation_fallback',
        _dependency: safeDependencyError(error)
      };
    }
  }

  async present({ decision, phone }) {
    const fallback = deterministicPresentation(decision);
    try {
      const safeDecision = {
        action: decision.action, language: decision.language, questions: decision.questions,
        alternatives: decision.alternatives, policy: decision.policy,
        operational_check: decision.operational_check, escalation: decision.escalation,
        presentation_contract: decision.presentation_contract
      };
      const candidate = await this.structured({
        name: 'pilot_presentation', schema: presentationSchema, phone,
        system: 'Return exactly the text and IDs from presentation_contract. Do not translate, paraphrase, add, remove, reorder, or infer anything. The contract is the only version authorized for final verification.',
        input: JSON.stringify(safeDecision)
      });
      if (candidate.text !== fallback.text
        || !sameIds(candidate.selected_item_ids, fallback.selected_item_ids)
        || !sameIds(candidate.selected_media_ids, fallback.selected_media_ids)) {
        return { ...fallback, _fallback: true, _error_code: 'ai_presentation_contract_fallback' };
      }
      return candidate;
    } catch (error) {
      return { ...fallback, _fallback: true, _error_code: 'ai_presentation_fallback', _dependency: safeDependencyError(error) };
    }
  }
}

module.exports = { PilotAi, deterministicInterpret, deterministicPresentation, interpretationSchema, presentationSchema, minimizeUserText };
