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
    budget_cop: { type: ['integer', 'null'], minimum: 1, maximum: 1000000000 },
    budget_period: { type: 'string', enum: ['absent', 'monthly', 'total', 'unknown'] },
    knowledge_topics: { type: 'array', items: { type: 'string', enum: [
      'overview', 'differences', 'location', 'parking', 'laundry', 'balcony',
      'air_conditioning', 'capacity', 'rules', 'policies', 'photos', 'other'
    ] }, maxItems: 12 },
    provided_fields: { type: 'array', items: { type: 'string', enum: [
      'check_in', 'check_out', 'nights', 'guests', 'requested_apartment_code',
      'budget', 'preferences', 'requirements'
    ] }, maxItems: 8 },
    corrections: { type: 'array', items: { type: 'string', enum: [
      'check_in', 'check_out', 'nights', 'guests', 'requested_apartment_code',
      'budget', 'preferences', 'requirements'
    ] }, maxItems: 8 },
    requests_human: { type: 'boolean' },
    uncertainty: { type: 'number', minimum: 0, maximum: 1 },
    needs_clarification: { type: 'boolean' },
    missing_fields: { type: 'array', items: { type: 'string', enum: ['check_in', 'check_out_or_nights', 'guests'] } }
  },
  required: [
    'intent', 'language', 'check_in', 'check_out', 'check_in_status', 'check_out_status',
    'check_in_source', 'check_out_source', 'nights', 'guests', 'requested_apartment_code',
    'requested_apartment_code_status', 'preferences', 'requirements', 'budget_cop',
    'budget_period', 'knowledge_topics', 'provided_fields', 'corrections',
    'requests_human', 'uncertainty', 'needs_clarification', 'missing_fields'
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

const numberWords = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, dieciséis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

function parseHumanNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (Object.hasOwn(numberWords, normalized)) return numberWords[normalized];
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function findNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseHumanNumber(match[1]);
  }
  return null;
}

function extractBudget(text) {
  const source = String(text || '');
  if (!/presupuesto|hasta|maximo|máximo|tope|budget/i.test(source)) {
    return { value: null, period: 'absent' };
  }
  const millions = source.match(/(?:presupuesto|hasta|maximo|máximo|tope|budget)[^\d]{0,20}(\d+(?:[.,]\d+)?)\s*millones?/i);
  const grouped = source.match(/(?:presupuesto|hasta|maximo|máximo|tope|budget)[^\d]{0,20}\$?\s*(\d{1,3}(?:[.\s]\d{3})+|\d{6,9})/i);
  let value = null;
  if (millions) value = Math.round(Number(millions[1].replace(',', '.')) * 1000000);
  else if (grouped) value = Number(grouped[1].replace(/[.\s]/g, ''));
  const period = /mensual|al mes|por mes|monthly/i.test(source)
    ? 'monthly' : /total|en total|por toda/i.test(source) ? 'total' : value ? 'unknown' : 'absent';
  return { value: Number.isSafeInteger(value) && value > 0 ? value : null, period };
}

function extractKnowledgeTopics(text) {
  const source = String(text || '');
  const topics = [];
  const add = (pattern, topic) => { if (pattern.test(source)) topics.push(topic); };
  add(/\bfotos?\b|\bim[aá]genes?\b|\bphotos?\b|\bpictures?\b/i, 'photos');
  add(/diferencia|comparar|comparacion|comparación|cual es mejor|cuál es mejor/i, 'differences');
  add(/donde queda|dónde queda|ubicacion|ubicación|zona|poblado/i, 'location');
  add(/parqueadero|parking|estacionamiento/i, 'parking');
  add(/lavanderia|lavandería|lavadora|secadora|laundry/i, 'laundry');
  add(/balcon|balcón|balcony/i, 'balcony');
  add(/aire acondicionado|air conditioning|\bAC\b/i, 'air_conditioning');
  add(/capacidad|cuantas personas|cuántas personas|cuantos caben|cuántos caben/i, 'capacity');
  add(/regla|reglas del edificio|visitantes|visitas/i, 'rules');
  add(/politica|política|cancelacion|cancelación|mascotas|pets?|accesibilidad/i, 'policies');
  add(/caracteristicas|características|que tiene|qué tiene|incluye|como es|cómo es/i, 'overview');
  return [...new Set(topics)];
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

// Spanish speakers say "el primero de octubre" (not "el uno de octubre"), and
// often type abbreviated ordinals like "1ro"/"2do"/"3ro" for any day. The
// deterministic date reader only matched bare digits, so these fell through
// to the bare-month-name pattern and were marked ambiguous.
const DAY_TOKEN_PATTERN = '(?:\\d{1,2}(?:er|ero|ro|do|to|vo|mo|no)?|primer[oa]?)';

function parseDayOrdinal(token) {
  const normalized = String(token || '').toLowerCase().trim();
  if (/^primer[oa]?$/.test(normalized)) return 1;
  const digitMatch = normalized.match(/^(\d{1,2})(?:er|ero|ro|do|to|vo|mo|no)?$/);
  return digitMatch ? Number(digitMatch[1]) : null;
}

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

  // "de 2026" and the more conversational "del año 2026" both name the year.
  const yearClause = 'de(?:l)?\\s+(?:año\\s+)?(\\d{4})';
  const monthPattern = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
  const rangePattern = new RegExp(`\\b(?:del\\s+)?(${DAY_TOKEN_PATTERN})\\s+(?:al|a)\\s+(${DAY_TOKEN_PATTERN})\\s+de\\s+(${monthPattern})\\s+${yearClause}\\b`, 'gi');
  for (const match of sourceText.matchAll(rangePattern)) {
    const month = spanishMonths[match[3].toLowerCase()];
    add(match.index, explicitDate(isoDate(Number(match[4]), month, parseDayOrdinal(match[1]))), match.index + match[0].length);
    signals.push({
      index: match.index + match[0].lastIndexOf(match[2]),
      evidence: explicitDate(isoDate(Number(match[4]), month, parseDayOrdinal(match[2])))
    });
  }

  const naturalPattern = new RegExp(`\\b(${DAY_TOKEN_PATTERN})\\s+de\\s+(${monthPattern})(?:\\s+${yearClause})?\\b`, 'gi');
  for (const match of sourceText.matchAll(naturalPattern)) {
    if (overlaps(match.index)) continue;
    const evidence = match[3]
      ? explicitDate(isoDate(Number(match[3]), spanishMonths[match[2].toLowerCase()], parseDayOrdinal(match[1])))
      : { value: null, status: 'ambiguous', source: 'user_explicit' };
    add(match.index, evidence, match.index + match[0].length);
  }

  // A month without a day is a real date signal, but never an exact stay.
  // Mark it ambiguous so reconciliation cannot accept dates invented by the
  // model (for example, silently expanding "en septiembre" to the full month).
  const partialMonthPattern = new RegExp(`\\b(${monthPattern})(?:\\s+de\\s+\\d{4}|\\s+\\d{4})?\\b`, 'gi');
  for (const match of sourceText.matchAll(partialMonthPattern)) {
    if (overlaps(match.index)) continue;
    add(match.index, { value: null, status: 'ambiguous', source: 'user_explicit' }, match.index + match[0].length);
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

function deterministicInterpret(text, { today, context = {} } = {}) {
  let dates = dateEvidence(text, today);
  // A message with only one date is inherently ambiguous by position alone:
  // it could be a check-in named first, or a check-out sent as its own
  // follow-up message after check-in was already resolved. Confirmed as a
  // real bug (2026-09-01): without this, a lone check-out date silently
  // overwrote the already-valid check-in instead of filling check-out, and
  // the guest got stuck being asked for a check-out date they had just sent.
  if (dates[0].status !== 'absent' && dates[1].status === 'absent'
    && context.check_in_status === 'valid' && context.check_in
    && Array.isArray(context.pending_fields) && context.pending_fields.includes('check_out_or_nights')) {
    const candidate = dates[0];
    const isAfterCheckIn = candidate.status !== 'valid' || !candidate.value || candidate.value > context.check_in;
    dates = [
      { value: null, status: 'absent', source: 'none' },
      isAfterCheckIn ? candidate : { value: null, status: 'invalid', source: 'user_explicit' }
    ];
  }
  const numberToken = '(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|dieciséis|diecisiete|dieciocho|diecinueve|veinte|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
  let nights = findNumber(text, [new RegExp(`${numberToken}\\s*(?:noches?|nights?)`, 'i')]);
  const weeks = findNumber(text, [new RegExp(`${numberToken}\\s*(?:semanas?|weeks?)`, 'i')]);
  const months = findNumber(text, [new RegExp(`${numberToken}\\s*(?:mes|meses|months?)`, 'i')]);
  if (!nights && weeks) nights = weeks * 7;
  if (!nights && months) nights = months * 30;
  let guests = findNumber(text, [
    new RegExp(`${numberToken}\\s*(?:personas?|hu[eé]spedes?|guests?|people)`, 'i'),
    new RegExp(`(?:somos|para)\\s+${numberToken}`, 'i')
  ]);
  const standalone = String(text || '').trim().match(new RegExp(`^${numberToken}[.!]?$`, 'i'));
  if (standalone && Array.isArray(context.pending_fields)) {
    if (!guests && context.pending_fields.includes('guests')) guests = parseHumanNumber(standalone[1]);
    if (!nights && context.pending_fields.includes('check_out_or_nights')) nights = parseHumanNumber(standalone[1]);
  }
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
  const budget = extractBudget(text);
  const knowledgeTopics = extractKnowledgeTopics(text);
  const providedFields = [];
  if (dates[0].status !== 'absent') providedFields.push('check_in');
  if (dates[1].status !== 'absent') providedFields.push('check_out');
  if (nights) providedFields.push('nights');
  if (guests) providedFields.push('guests');
  if (requestedApartmentCode) providedFields.push('requested_apartment_code');
  if (budget.value) providedFields.push('budget');
  if (preferences.length) providedFields.push('preferences');
  if (requirements.length) providedFields.push('requirements');
  const correctionSignal = /\b(no[, ]|mejor|perd[oó]n|quise decir|corrijo|finalmente)\b/i.test(text);
  const requestsHuman = /hablar con (?:una persona|alguien|jose|jos[eé])|asesor|humano|llamarme/i.test(text);
  const greeting = /hola|hello|\bhi\b|buen(?:os)? d[ií]as|buenas/i.test(text) && text.trim().split(/\s+/).length < 5;
  const searchSignal = providedFields.length > 0 || /busco|necesito|quiero|alojamiento|apartamento|estad[ií]a|hospedar/i.test(text);
  const interpretation = {
    intent: greeting ? 'greeting' : knowledgeTopics.length ? 'lodging_question' : searchSignal ? 'lodging_search' : 'unknown',
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
    budget_cop: budget.value, budget_period: budget.period,
    knowledge_topics: knowledgeTopics, provided_fields: [...new Set(providedFields)],
    corrections: correctionSignal ? [...new Set(providedFields)] : [], requests_human: requestsHuman,
    uncertainty: 0.15, needs_clarification: false, missing_fields: []
  };
  interpretation.missing_fields = computeMissing(interpretation);
  interpretation.needs_clarification = interpretation.missing_fields.length > 0;
  interpretation.uncertainty = interpretation.needs_clarification ? 0.45 : 0.15;
  return interpretation;
}

function reconcileInterpretation(text, modelInterpretation = {}, { today, context = {} } = {}) {
  const deterministic = deterministicInterpret(text, { today, context });
  const reconciled = {
    ...deterministic,
    ...modelInterpretation,
    preferences: Array.isArray(modelInterpretation.preferences)
      ? modelInterpretation.preferences : deterministic.preferences,
    requirements: Array.isArray(modelInterpretation.requirements)
      ? modelInterpretation.requirements : deterministic.requirements,
    budget_cop: modelInterpretation.budget_cop ?? deterministic.budget_cop,
    budget_period: modelInterpretation.budget_period || deterministic.budget_period,
    knowledge_topics: [...new Set([
      ...deterministic.knowledge_topics,
      ...(Array.isArray(modelInterpretation.knowledge_topics) ? modelInterpretation.knowledge_topics : [])
    ])],
    provided_fields: [...new Set([
      ...deterministic.provided_fields,
      ...(Array.isArray(modelInterpretation.provided_fields) ? modelInterpretation.provided_fields : [])
    ])],
    corrections: [...new Set([
      ...deterministic.corrections,
      ...(Array.isArray(modelInterpretation.corrections) ? modelInterpretation.corrections : [])
    ])],
    requests_human: deterministic.requests_human || modelInterpretation.requests_human === true
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
  else if (hasDateSignal) {
    // Do not preserve a duration derived only from model-invented boundaries.
    // Explicit durations are already recognized deterministically above.
    reconciled.nights = null;
    reconciled.provided_fields = reconciled.provided_fields.filter((field) => field !== 'nights');
  }
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

  async interpret({ text, phone, today, context = {} }) {
    if (/^\[M0_UNSUPPORTED_INBOUND:[a-z0-9_]+\]$/.test(String(text || ''))) {
      return { ...deterministicInterpret('', { today, context }), _fallback: true,
        _error_code: 'unsupported_inbound_type', _dependency: { status: null, code: 'unsupported_inbound_type', type: 'local' } };
    }
    try {
      const interpreted = await this.structured({
        name: 'pilot_interpretation', schema: interpretationSchema, phone,
        system: 'Extract only candidate meaning from the current lodging conversation message. Preserve explicit dates and apartment codes. Mark invalid or ambiguous dates; do not invent them. Extract guests, duration, COP budget and its period, basic preferences, mandatory requirements, commercial knowledge topics, explicit corrections and requests for a human. provided_fields must name only facts supplied or corrected in the current message. The context only explains short replies and pending questions; never copy a context value into provided_fields. Do not decide price, availability, eligibility, policy, booking, identity or any operational fact. Return dates in ISO format.',
        input: `Current date in America/Bogota: ${today}. Minimal authorized conversation context:\n${JSON.stringify(context)}\nCustomer message:\n${minimizeUserText(text)}`
      });
      return reconcileInterpretation(text, interpreted, { today, context });
    } catch (error) {
      return {
        ...deterministicInterpret(text, { today, context }), _fallback: true, _error_code: 'ai_interpretation_fallback',
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
  dateEvidence, parseDayOrdinal
};
