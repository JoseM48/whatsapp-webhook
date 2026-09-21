'use strict';

// semantic_confirmation -- Bloque B.
//
// No es un paso del flujo ni un formulario. Es un ESTADO que el sistema puede
// exigir, con disparadores deterministas -- no con la corazonada del modelo.
// El modelo puede SUGERIR (`suggests_confirmation`), pero quien decide es esto.
//
// Por que determinista: si el disparo dependiera del modelo, la confirmacion
// aparecería unas veces si y otras no ante el mismo caso, y la que mas importa
// -- la previa a comprometer inventario -- seria justamente la que podria
// faltar.
//
// Estado persistido en role_state.commercial_context.pending_confirmation.
// Sin migracion: ese JSONB ya existe.

const STATUS = Object.freeze({
  AWAITING: 'awaiting',
  CONFIRMED: 'confirmed',
  CORRECTED: 'corrected',
  REJECTED: 'rejected',
  AMBIGUOUS: 'ambiguous',
  EXPIRED: 'expired'
});

const TRIGGER = Object.freeze({
  LOW_CONFIDENCE: 'low_confidence',
  REPEATED_CORRECTIONS: 'repeated_corrections',
  ANAPHORA_RESOLVED: 'anaphora_resolved',
  PRICE_AFFECTING_CHANGE: 'price_affecting_change',
  BEFORE_ACTION: 'before_action'
});

const CONFIDENCE_FLOOR = 0.7;
const PRICE_FIELDS = new Set(['arrival', 'duration', 'guests', 'apartment']);

// Campos cuya confianza baja SI importa: los que mueven precio o
// disponibilidad. Dudar del idioma no justifica interrumpir al huesped.
function lowConfidenceFields(v2) {
  const stay = v2?.stay || {};
  const out = [];
  if ((stay.arrival?.confidence ?? 1) < CONFIDENCE_FLOOR && stay.arrival?.kind !== 'none') out.push('arrival');
  if ((stay.duration?.confidence ?? 1) < CONFIDENCE_FLOOR && stay.duration?.kind !== 'none') out.push('duration');
  if ((stay.guests?.confidence ?? 1) < CONFIDENCE_FLOOR && stay.guests?.total) out.push('guests');
  return out;
}

/**
 * Decide si este turno exige confirmacion.
 * @param {object} v2             interpretacion V2 del turno
 * @param {object} context        commercial_context previo
 * @param {object} opts
 * @param {Array}  opts.recentCorrections corrections de los ultimos turnos
 * @param {Array}  opts.toolTrace  traza del lazo de tools
 * @param {string} opts.pendingAction accion economica a punto de ejecutarse
 */
function evaluateConfirmationNeed(v2, context = {}, opts = {}) {
  const triggers = [];
  const fields = new Set();

  // 1. Antes de una accion economica: OBLIGATORIA, sin excepcion y sin
  //    importar la confianza. Es la unica regla que no admite matices.
  if (opts.pendingAction) {
    triggers.push(TRIGGER.BEFORE_ACTION);
    for (const f of PRICE_FIELDS) fields.add(f);
  }

  // 2. Confianza insuficiente en un campo que mueve dinero.
  const low = lowConfidenceFields(v2);
  if (low.length) { triggers.push(TRIGGER.LOW_CONFIDENCE); low.forEach((f) => fields.add(f)); }

  // 3. Dos o mas correcciones recientes: el huesped ya nos corrigio, no
  //    conviene seguir construyendo encima sin verificar.
  const recent = Array.isArray(opts.recentCorrections) ? opts.recentCorrections : [];
  if (recent.length + (v2?.corrections || []).length >= 2) {
    triggers.push(TRIGGER.REPEATED_CORRECTIONS);
    (v2?.corrections || []).forEach((f) => fields.add(f));
  }

  // 4. Una referencia resuelta por inferencia -- no por codigo explicito.
  const resolvedByInference = (opts.toolTrace || []).some(
    (t) => t.tool === 'resolve_apartment_reference' && t.status === 'ok'
  ) && (v2?.references || []).some((r) => r.hint_type === 'anaphora' || r.hint_type === 'attribute');
  if (resolvedByInference) { triggers.push(TRIGGER.ANAPHORA_RESOLVED); fields.add('apartment'); }

  // 5. Cambio que mueve el precio HABIENDO ya una propuesta vigente.
  const hasProposal = Boolean(context?.proposal_snapshot);
  const changed = (v2?.corrections || []).filter((c) => PRICE_FIELDS.has(c));
  if (hasProposal && changed.length) {
    triggers.push(TRIGGER.PRICE_AFFECTING_CHANGE);
    changed.forEach((f) => fields.add(f));
  }

  return {
    required: triggers.length > 0,
    triggers: [...new Set(triggers)],
    fields: [...fields],
    // Se registra la sugerencia del modelo para poder medir despues cuanto
    // coincide con las reglas, pero NO participa en la decision.
    model_suggested: Boolean(v2?.suggests_confirmation)
  };
}

// El resumen que Cami dira en voz alta. Se construye desde el estado, no desde
// texto del modelo: asi no puede confirmar algo distinto de lo que se guardo.
function buildConfirmationSnapshot(v2, context = {}) {
  const stay = v2?.stay || {};
  return {
    guests: stay.guests?.total ?? context.guests ?? null,
    arrival_date: stay.arrival?.date ?? context.check_in ?? null,
    arrival_precision: stay.arrival?.precision ?? null,
    nights: stay.duration?.nights ?? context.nights ?? null,
    duration_kind: stay.duration?.kind ?? null,
    apartment_code: (v2?.references || []).find((r) => r.resolved_code)?.resolved_code
      ?? context.requested_apartment_code ?? null
  };
}

function openConfirmation({ evaluation, v2, context, now = new Date() }) {
  return {
    status: STATUS.AWAITING,
    asked_at: now.toISOString(),
    triggers: evaluation.triggers,
    fields: evaluation.fields,
    snapshot: buildConfirmationSnapshot(v2, context),
    model_suggested: evaluation.model_suggested
  };
}

/**
 * Resuelve una confirmacion abierta con el turno siguiente.
 *
 * REGLA DURA: mientras este `awaiting`, una accion economica NO puede
 * ejecutarse. Y una correccion actualiza el estado ANTES de continuar --
 * nunca se sigue adelante con el snapshot viejo.
 */
function resolveConfirmation(pending, v2, { affirmative = null } = {}) {
  if (!pending || pending.status !== STATUS.AWAITING) {
    return { pending, outcome: null, blocks_action: false };
  }

  const hasCorrections = (v2?.corrections || []).length > 0;
  const changedFields = (v2?.corrections || []).filter((c) => PRICE_FIELDS.has(c));

  if (hasCorrections || changedFields.length) {
    return {
      pending: { ...pending, status: STATUS.CORRECTED, resolved_at: new Date().toISOString(),
        corrected_fields: changedFields },
      outcome: STATUS.CORRECTED,
      // Corregido: el estado se actualiza y la accion sigue bloqueada hasta
      // que el nuevo entendimiento se confirme.
      blocks_action: true
    };
  }

  if (affirmative === true) {
    return { pending: { ...pending, status: STATUS.CONFIRMED, resolved_at: new Date().toISOString() },
      outcome: STATUS.CONFIRMED, blocks_action: false };
  }

  if (affirmative === false) {
    return { pending: { ...pending, status: STATUS.REJECTED, resolved_at: new Date().toISOString() },
      outcome: STATUS.REJECTED, blocks_action: true };
  }

  // Ni si ni no ni correccion: el huesped hablo de otra cosa. No se asume
  // confirmacion por silencio -- ese es justo el error que esto previene.
  return { pending: { ...pending, status: STATUS.AMBIGUOUS },
    outcome: STATUS.AMBIGUOUS, blocks_action: true };
}

// Si hay una confirmacion abierta o no resuelta, ninguna accion economica sale.
function actionIsBlocked(pending) {
  if (!pending) return false;
  return [STATUS.AWAITING, STATUS.AMBIGUOUS, STATUS.CORRECTED, STATUS.REJECTED].includes(pending.status);
}

module.exports = {
  STATUS, TRIGGER, CONFIDENCE_FLOOR,
  evaluateConfirmationNeed, openConfirmation, resolveConfirmation,
  buildConfirmationSnapshot, actionIsBlocked, lowConfidenceFields
};
