'use strict';

// Schema conversacional ampliado -- Bloque B.
//
// El schema vigente (ai.js:27) tiene 24 campos obligatorios y
// additionalProperties:false. Su problema medido no son los enums: es que NO
// TIENE DONDE PONER lo que el modelo entiende y no cabe, asi que ese
// significado se descarta en silencio. El baseline legacy lo mostro en tres
// casos concretos ("tal vez mas", "2 adultos y un bebe", "el otro que me
// mostraste").
//
// Este schema añade cuatro cosas, y ninguna le da autoridad al modelo sobre
// hechos operativos:
//   1. `ambiguity`  -- lo que el modelo NO pudo resolver, explicitamente.
//   2. `confidence` -- por campo, para que la confirmacion semantica tenga un
//      disparador objetivo en vez de una corazonada.
//   3. `duration`   -- semantica de duracion (exacta / minima / abierta), que
//      hoy no existe y es justo lo que pierde el escenario "un mes, tal vez mas".
//   4. `references` -- referencias conversacionales sin resolver, que es lo que
//      habilita resolve_apartment_reference en vez de adivinar.
//
// Y `unmapped_meaning`: un campo de texto libre, acotado y auditable, donde el
// modelo deja lo que entendio y no cupo. Sin esto no hay forma de saber que se
// esta perdiendo; con esto, la perdida es medible.

const CONFIDENCE = { type: 'number', minimum: 0, maximum: 1 };

const interpretationSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['lodging_search', 'lodging_question', 'greeting', 'other', 'unknown'] },
    language: { type: 'string', enum: ['es', 'en'] },

    // --- estadia: sustituye el par rigido check_in/check_out ---------------
    stay: {
      type: 'object', additionalProperties: false,
      properties: {
        arrival: {
          type: 'object', additionalProperties: false,
          properties: {
            // `kind` separa "no dijo nada" de "dijo algo impreciso", que hoy
            // se confunden: ambas terminan en null.
            kind: { type: 'string', enum: ['exact', 'approximate', 'none'] },
            date: { type: ['string', 'null'], format: 'date' },
            // Cuanto vale esa fecha. "a principios de octubre" es `month`,
            // no una fecha invalida.
            precision: { type: 'string', enum: ['day', 'week', 'month', 'unknown'] },
            confidence: CONFIDENCE
          },
          required: ['kind', 'date', 'precision', 'confidence']
        },
        duration: {
          type: 'object', additionalProperties: false,
          properties: {
            nights: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
            // `minimum` es lo que expresa "un mes, tal vez mas"; `open` es
            // "no se cuanto todavia". Hoy las tres caen en el mismo entero.
            kind: { type: 'string', enum: ['exact', 'minimum', 'open', 'none'] },
            confidence: CONFIDENCE
          },
          required: ['nights', 'kind', 'confidence']
        },
        guests: {
          type: 'object', additionalProperties: false,
          properties: {
            total: { type: ['integer', 'null'], minimum: 1, maximum: 20 },
            // La composicion importa para capacidad y para cuna. Hoy se pierde.
            adults: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
            children: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
            infants: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
            confidence: CONFIDENCE
          },
          required: ['total', 'adults', 'children', 'infants', 'confidence']
        }
      },
      required: ['arrival', 'duration', 'guests']
    },

    // --- referencias conversacionales sin resolver -------------------------
    // El modelo NO resuelve el codigo: declara que hay una referencia y con
    // que pistas. Resolverla es trabajo de una tool contra fuentes
    // autoritativas. Esta separacion es la que impide inventar un LF-XXX.
    references: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['apartment'] },
          raw: { type: 'string', maxLength: 120 },
          hint_type: { type: 'string', enum: ['number_fragment', 'attribute', 'anaphora', 'ordinal', 'unknown'] },
          hint_value: { type: ['string', 'null'], maxLength: 80 },
          resolved_code: { type: ['string', 'null'], pattern: '^LF-[0-9]{3,4}$' }
        },
        required: ['kind', 'raw', 'hint_type', 'hint_value', 'resolved_code']
      }
    },

    budget: {
      type: 'object', additionalProperties: false,
      properties: {
        amount_cop: { type: ['integer', 'null'], minimum: 1, maximum: 1000000000 },
        period: { type: 'string', enum: ['absent', 'monthly', 'total', 'unknown'] }
      },
      required: ['amount_cop', 'period']
    },

    preferences: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },
    requirements: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 12 },

    knowledge_topics: {
      type: 'array', maxItems: 12,
      items: { type: 'string', enum: [
        'overview', 'differences', 'location', 'parking', 'laundry', 'balcony',
        'air_conditioning', 'capacity', 'pets', 'channel_routing', 'address_disclosure',
        'cancellation', 'check_in_out_schedule', 'deposit', 'photos', 'other'
      ] }
    },

    corrections: {
      type: 'array', maxItems: 8,
      items: { type: 'string', enum: ['arrival', 'duration', 'guests', 'apartment', 'budget', 'preferences', 'requirements'] }
    },

    // --- lo que NO se pudo resolver, dicho en voz alta ---------------------
    ambiguity: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          field: { type: 'string', enum: ['arrival', 'duration', 'guests', 'apartment', 'budget', 'intent', 'other'] },
          reason: { type: 'string', maxLength: 160 },
          candidates: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 4 }
        },
        required: ['field', 'reason', 'candidates']
      }
    },

    // El desague auditable. Sin esto la perdida semantica es invisible.
    unmapped_meaning: { type: ['string', 'null'], maxLength: 300 },

    requests_human: { type: 'boolean' },
    exception_request: { type: 'boolean' },

    // P0-2 (2026-09-24): cancelar no es negociar. Sin senal propia, el
    // unico sitio donde cabia "quiero cancelar" era exception_request, y
    // eso mandaba al huesped a escalamiento humano dejando su pre-reserva
    // viva (M0-20260924-FD2FAD8E).
    cancellation_request: { type: 'boolean' },

    // Sugerencia del modelo, NO decision. El disparo real lo decide
    // semantic-confirmation.js con reglas deterministas.
    suggests_confirmation: { type: 'boolean' }
  },
  required: [
    'intent', 'language', 'stay', 'references', 'budget', 'preferences', 'requirements',
    'knowledge_topics', 'corrections', 'ambiguity', 'unmapped_meaning',
    'requests_human', 'exception_request', 'cancellation_request', 'suggests_confirmation'
  ]
};

// Proyeccion V2 -> forma que pms-lite ya entiende. El motor de decision, el
// packet y el validador NO cambian: reciben exactamente los mismos campos de
// siempre. Toda la riqueza nueva viaja aparte, en `_v2`.
function isoPlusDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function projectToLegacyInterpretation(v2) {
  const arrival = v2?.stay?.arrival || {};
  const duration = v2?.stay?.duration || {};
  const guests = v2?.stay?.guests || {};
  const apartmentRef = (v2?.references || []).find((r) => r.kind === 'apartment' && r.resolved_code);

  const arrivalStatus = arrival.kind === 'exact' && arrival.date ? 'valid'
    : arrival.kind === 'approximate' ? 'ambiguous' : 'absent';

  const provided = [];
  if (arrival.kind !== 'none' && arrival.date) provided.push('check_in');
  if (duration.nights) provided.push('nights');
  if (guests.total) provided.push('guests');
  if (apartmentRef) provided.push('requested_apartment_code');
  if (v2?.budget?.amount_cop) provided.push('budget');
  if ((v2?.preferences || []).length) provided.push('preferences');
  if ((v2?.requirements || []).length) provided.push('requirements');

  const CORRECTION_MAP = { arrival: 'check_in', duration: 'nights', guests: 'guests',
    apartment: 'requested_apartment_code', budget: 'budget',
    preferences: 'preferences', requirements: 'requirements' };

  // La salida se DERIVA de llegada + duracion en vez de pedirse aparte: el
  // huesped que dice "del 10 al 17" no dio dos hechos independientes, dio uno.
  // Solo se deriva cuando ambos son exactos: con una llegada aproximada o una
  // duracion minima, una fecha de salida concreta seria inventada.
  const derivedCheckOut = (arrivalStatus === 'valid' && arrival.date && duration.nights && duration.kind === 'exact')
    ? isoPlusDays(arrival.date, duration.nights) : null;

  const missing = [];
  if (arrivalStatus !== 'valid') missing.push('check_in');
  if (!duration.nights) missing.push('check_out_or_nights');
  if (!guests.total) missing.push('guests');

  return {
    intent: v2.intent, language: v2.language,
    check_in: arrival.date ?? null, check_out: derivedCheckOut,
    check_in_status: arrivalStatus, check_out_status: derivedCheckOut ? 'valid' : 'absent',
    check_in_source: arrival.date ? 'model_interpreted' : 'none',
    check_out_source: derivedCheckOut ? 'calculated' : 'none',
    nights: duration.nights ?? null, guests: guests.total ?? null,
    requested_apartment_code: apartmentRef ? apartmentRef.resolved_code : null,
    requested_apartment_code_status: apartmentRef ? 'provided' : 'absent',
    preferences: v2.preferences || [], requirements: v2.requirements || [],
    budget_cop: v2?.budget?.amount_cop ?? null, budget_period: v2?.budget?.period || 'absent',
    knowledge_topics: v2.knowledge_topics || [],
    provided_fields: [...new Set(provided)],
    corrections: [...new Set((v2.corrections || []).map((c) => CORRECTION_MAP[c]).filter(Boolean))],
    requests_human: Boolean(v2.requests_human),
    exception_request: Boolean(v2.exception_request),
    cancellation_request: Boolean(v2.cancellation_request),
    // Solo cuenta la confianza de lo que el huesped REALMENTE dijo. Antes se
    // tomaba el minimo entre los tres campos siempre, asi que "el 15 de
    // octubre" -- fecha clarisima, sin personas ni duracion -- salia con
    // incertidumbre 1,00: el numero describia lo que el modelo NO sabia, no
    // su duda sobre lo que sabia. Con la politica de confirmacion leyendo
    // este campo, eso habria abierto confirmaciones falsas en casi todos los
    // primeros turnos.
    uncertainty: 1 - Math.min(...[
      arrival.date ? (arrival.confidence ?? 0.5) : null,
      duration.nights ? (duration.confidence ?? 0.5) : null,
      guests.total ? (guests.confidence ?? 0.5) : null
    ].filter((v) => v !== null).concat([1])),
    needs_clarification: missing.length > 0,
    missing_fields: missing,
    _v2: v2
  };
}

module.exports = { interpretationSchemaV2, projectToLegacyInterpretation };
