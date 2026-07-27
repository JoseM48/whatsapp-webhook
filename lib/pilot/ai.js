'use strict';

const { safetyIdentifier } = require('./security');

const interpretationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['lodging_search', 'lodging_question', 'greeting', 'other', 'unknown'] },
    language: { type: 'string', enum: ['es', 'en'] },
    check_in: { type: ['string', 'null'], format: 'date' },
    check_out: { type: ['string', 'null'], format: 'date' },
    check_in_status: { type: 'string', enum: ['absent', 'valid', 'invalid', 'ambiguous'] },
    check_out_status: { type: 'string', enum: ['absent', 'valid', 'invalid', 'ambiguous'] },
    check_in_source: { type: 'string', enum: ['none', 'user_explicit', 'model_interpreted', 'calculated'] },
    check_out_source: { type: 'string', enum: ['none', 'user_explicit', 'model_interpreted', 'calculated'] },
    nights: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
    guests: { type: ['integer', 'null'], minimum: 1, maximum: 20 },
    requested_apartment_code: { type: ['string', 'null'], pattern: '^LF-[0-9]{3,4}$' },
    requested_apartment_code_status: { type: 'string', enum: ['absent', 'provided'] },
    preferences: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    requirements: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    uncertainty: { type: 'number', minimum: 0, maximum: 1 },
    needs_clarification: { type: 'boolean' },
    missing_fields: { type: 'array', items: { type: 'string', enum: ['check_in', 'check_out_or_nights', 'guests'] } }
  },
  required: [
    'intent', 'language', 'check_in', 'check_out', 'check_in_status', 'check_out_status',
    'check_in_source', 'check_out_source', 'nights', 'guests', 'requested_apartment_code',
    'requested_apartment_code_status', 'preferences', 'requirements', 'uncertainty',
    'needs_clarification', 'missing_fields'
  ]
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
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, (match) => (
      /^\d{4}-\d{2}-\d{2}$/.test(match) ? match : '[phone-redacted]'
    ))
    .slice(0, 1500);
}

function findNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isoDate(year, month, day) {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(value) ? value : null;
}

function addIsoDays(value, days) {
  if (!isValidIsoDate(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function extractApartmentCode(text) {
  const match = String(text || '').match(/\bLF[\s-]?(\d{3,4})\b/i);
  return match ? `LF-${match[1]}` : null;
}

const spanishMonths = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12
};

function explicitDate(value, source = 'user_explicit') {
  return value
    ? { value, status: 'valid', source }
    : { value: null, status: 'invalid', source: 'user_explicit' };
}

function parseSlashDate(token) {
  const parts = token.split(/[/-]/);
  if (parts.length !== 3 || parts[2].length !== 4) {
    return { value: null, status: 'ambiguous', source: 'user_explicit' };
  }
  const [first, second, year] = parts.map(Number);
  if (!first || !second || !year || first > 31 || second > 31) return explicitDate(null);
  if (first <= 12 && second <= 12) {
    return { value: null, status: 'ambiguous', source: 'user_explicit' };
  }
  if (first > 12 && second <= 12) return explicitDate(isoDate(year, second, first));
  if (second > 12 && first <= 12) return explicitDate(isoDate(year, first, second));
  return explicitDate(null);
}

function collectDateSignals(text, today) {
  const sourceText = String(text || '');
  const signals = [];
  const occupied = [];
  const add = (index, evidence, end = index) => {
    signals.push({ index, evidence });
    occupied.push([index, end]);
  };
  const overlaps = (index) => occupied.some(([start, end]) => index >= start && index < end);

  for (const match of sourceText.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    add(match.index, explicitDate(isValidIsoDate(match[0]) ? match[0] : null), match.index + match[0].length);
  }

  for (const match of sourceText.matchAll(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g)) {
    if (!overlaps(match.index)) add(match.index, parseSlashDate(match[0]), match.index + match[0].length);
  }

  const monthPattern = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
  const rangePattern = new RegExp(`\\b(?:del\\s+)?(\\d{1,2})\\s+(?:al|a)\\s+(\\d{1,2})\\s+de\\s+(${monthPattern})\\s+de\\s+(\\d{4})\\b`, 'gi');
  for (const match of sourceText.matchAll(rangePattern)) {
    const month = spanishMonths[match[3].toLowerCase()];
    add(match.index, explicitDate(isoDate(Number(match[4]), month, Number(match[1]))), match.index + match[0].length);
    signals.push({
      index: match.index + match[0].lastIndexOf(match[2]),
      evidence: explicitDate(isoDate(Number(match[4]), month, Number(match[2])))
    });
  }

  const naturalPattern = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${monthPattern})(?:\\s+de\\s+(\\d{4}))?\\b`, 'gi');
  for (const match of sourceText.matchAll(naturalPattern)) {
    if (overlaps(match.index)) continue;
    const evidence = match[3]
      ? explicitDate(isoDate(Number(match[3]), spanishMonths[match[2].toLowerCase()], Number(match[1])))
      : { value: null, status: 'ambiguous', source: 'user_explicit' };
    add(match.index, evidence, match.index + match[0].length);
  }

  for (const match of sourceText.matchAll(/\b(hoy|mañana|today|tomorrow)\b/gi)) {
    if (overlaps(match.index)) continue;
    const offset = /mañana|tomorrow/i.test(match[1]) ? 1 : 0;
    const value = addIsoDays(today, offset);
    add(match.index, value
      ? { value, status: 'valid', source: 'calculated' }
      : { value: null, status: 'ambiguous', source: 'user_explicit' },
    match.index + match[0].length);
  }

  return signals.sort((left, right) => left.index - right.index).map((item) => item.evidence).slice(0, 2);
}

function dateEvidence(text, today) {
  const signals = collectDateSignals(text, today);
  const evidence = [0, 1].map((index) => {
    if (signals[index]) return signals[index];
    return { value: null, status: 'absent', source: 'none' };
  });
  if (evidence[0].status === 'valid' && evidence[1].status === 'valid'
    && evidence[1].value <= evidence[0].value) {
    evidence[1] = { value: null, status: 'invalid', source: 'user_explicit' };
  }
  return evidence;
}

function computeMissing(interpretation) {
  const missing = [];
  if (!interpretation.check_in || interpretation.check_in_status !== 'valid') missing.push('check_in');
  if ((!interpretation.check_out || interpretation.check_out_status !== 'valid') && !interpretation.nights) {
    missing.push('check_out_or_nights');
  }
  if (!interpretation.guests) missing.push('guests');
  return missing;
}

function deterministicInterpret(text, { today } = {}) {
  const dates = dateEvidence(text, today);
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
  const requestedApartmentCode = extractApartmentCode(text);
  const interpretation = {
    intent: /hola|hello|\bhi\b/i.test(text) && text.trim().split(/\s+/).length < 4 ? 'greeting' : 'lodging_search',
    language: detectLanguage(text),
    check_in: dates[0].value,
    check_out: dates[1].value,
    check_in_status: dates[0].status,
    check_out_status: dates[1].status,
    check_in_source: dates[0].source,
    check_out_source: dates[1].source,
    nights, guests, preferences: [...new Set(preferences)], requirements: [...new Set(requirements)],
    requested_apartment_code: requestedApartmentCode,
    requested_apartment_code_status: requestedApartmentCode ? 'provided' : 'absent',
    uncertainty: 0.15, needs_clarification: false, missing_fields: []
  };
  interpretation.missing_fields = computeMissing(interpretation);
  interpretation.needs_clarification = interpretation.missing_fields.length > 0;
  interpretation.uncertainty = interpretation.needs_clarification ? 0.45 : 0.15;
  return interpretation;
}

function reconcileInterpretation(text, modelInterpretation = {}, { today } = {}) {
  const deterministic = deterministicInterpret(text, { today });
  const reconciled = {
    ...deterministic,
    ...modelInterpretation,
    preferences: Array.isArray(modelInterpretation.preferences)
      ? modelInterpretation.preferences : deterministic.preferences,
    requirements: Array.isArray(modelInterpretation.requirements)
      ? modelInterpretation.requirements : deterministic.requirements
  };
  const evidence = dateEvidence(text, today);
  const hasDateSignal = evidence.some((item) => item.status !== 'absent');

  for (const [index, field] of ['check_in', 'check_out'].entries()) {
    const statusField = `${field}_status`;
    const sourceField = `${field}_source`;
    if (evidence[index].status !== 'absent') {
      reconciled[field] = evidence[index].value;
      reconciled[statusField] = evidence[index].status;
      reconciled[sourceField] = evidence[index].source;
    } else if (hasDateSignal || !isValidIsoDate(modelInterpretation[field])) {
      reconciled[field] = null;
      reconciled[statusField] = 'absent';
      reconciled[sourceField] = 'none';
    } else {
      reconciled[field] = modelInterpretation[field];
      reconciled[statusField] = 'valid';
      reconciled[sourceField] = 'model_interpreted';
    }
  }

  if (deterministic.nights) reconciled.nights = deterministic.nights;
  if (deterministic.guests) reconciled.guests = deterministic.guests;
  if (deterministic.requested_apartment_code) {
    reconciled.requested_apartment_code = deterministic.requested_apartment_code;
    reconciled.requested_apartment_code_status = 'provided';
  } else {
    const modelCode = extractApartmentCode(modelInterpretation.requested_apartment_code);
    reconciled.requested_apartment_code = modelCode;
    reconciled.requested_apartment_code_status = modelCode ? 'provided' : 'absent';
  }
  reconciled.missing_fields = computeMissing(reconciled);
  reconciled.needs_clarification = reconciled.missing_fields.length > 0;
  return reconciled;
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
      const interpreted = await this.structured({
        name: 'pilot_interpretation', schema: interpretationSchema, phone,
        system: 'Extract only the requested lodging-search fields. Preserve explicit dates and apartment codes. Mark invalid or ambiguous dates; do not invent them. Do not infer missing dates, guests, price, availability, booking, identity, or sensitive data. Return dates in ISO format. Preferences are desirable; requirements are mandatory only when the user clearly says so.',
        input: `Current date in America/Bogota: ${today}. Customer message:\n${minimizeUserText(text)}`
      });
      return reconcileInterpretation(text, interpreted, { today });
    } catch (error) {
      return {
        ...deterministicInterpret(text, { today }), _fallback: true, _error_code: 'ai_interpretation_fallback',
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

module.exports = {
  PilotAi, deterministicInterpret, reconcileInterpretation, deterministicPresentation,
  interpretationSchema, presentationSchema, minimizeUserText, isValidIsoDate, extractApartmentCode,
  dateEvidence
};
