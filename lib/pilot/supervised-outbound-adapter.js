'use strict';

const crypto = require('crypto');

const templates = Object.freeze({
  payment_request_lead: ['lf_solicitud_pago_v1', 'Tu pre-reserva {{1}} para {{2}}, del {{3}} al {{4}}, fue aprobada. Para continuar, realiza el anticipo de COP {{5}} antes del {{6}}. La reserva solo queda confirmada después de validar el pago y bloquear la disponibilidad en Airbnb.'],
  payment_reminder_lead: ['lf_recordatorio_pago_v1', 'Recordatorio de tu pre-reserva {{1}} para {{2}}. El anticipo pendiente es de COP {{3}} y el plazo vence el {{4}}. Si ya pagaste, envía el soporte por este chat. La reserva aún no está confirmada.'],
  reservation_preapproved_pending_reconciliation: ['lf_soporte_pago_recibido_v1', 'Recibimos el soporte de pago de la pre-reserva {{1}} para {{2}}. El pago está pendiente de validación. La reserva todavía no está confirmada. Te avisaremos cuando finalice la verificación.'],
  payment_window_expired_lead: ['lf_ventana_pago_vencida_v1', 'El plazo de pago de la pre-reserva {{1}} para {{2}} venció y la disponibilidad fue liberada. Si deseas continuar, escríbenos para consultar nuevamente disponibilidad y precio.'],
  reservation_confirmed_lead: ['lf_reserva_confirmada_v1', 'Tu reserva {{1}} para {{2}}, del {{3}} al {{4}}, está confirmada. Anticipo recibido y conciliado: COP {{5}}. Saldo pendiente: COP {{6}}. Conserva este mensaje como referencia de la reserva.'],
  payment_evidence_owner_reconciliation: ['lf_conciliar_pago_propietario_v1', null],
  payment_reconciled_pending_airbnb: ['lf_bloqueo_airbnb_gerente_v1', 'El pago de la pre-reserva {{1}}, apartamento {{2}}, ya fue conciliado. Falta verificar el bloqueo de disponibilidad en Airbnb antes de confirmar la reserva.'],
  reservation_confirmed_reception: ['lf_reserva_recepcion_v1', 'Reserva confirmada {{1}} para el apartamento {{2}}. Check-in: {{3}}. Check-out: {{4}}. Personas: {{5}}. Sigue únicamente las instrucciones operativas vigentes asociadas a esta reserva.'],
  operations_calendar_update: ['lf_calendario_operaciones_v1', 'Actualización de calendario versión {{1}}. Apartamento {{2}}. Cambio: {{3}}. Check-in: {{4}}. Check-out: {{5}}. Estado operativo: {{6}}. Usa esta versión y descarta planes anteriores que entren en conflicto.'],
  operations_same_day_cancellation_confirmation: ['lf_cancelacion_mismo_dia_operaciones_v1', 'Cambio de calendario versión {{1}}. Se propone cancelar el alistamiento {{2}} del apartamento {{3}} para hoy. Confirma NADIE ENVIADO únicamente si no se ha despachado ninguna persona. El silencio no cancela la tarea.'],
  operations_daily_plan: ['lf_plan_operaciones_v1', 'Plan de Operaciones para {{1}}, versión {{2}}. Alistamientos programados: {{3}}. Revisa el detalle asociado y confirma disponibilidad. Una actualización posterior reemplaza esta versión.'],
  operations_readiness_report: ['lf_reporte_alistamiento_v1', 'Operaciones reportó el alistamiento {{1}} del apartamento {{2}} con estado {{3}}. Observación codificada: {{4}}. Consulta el registro operativo asociado.'],
  operations_return_compensation: ['lf_retorno_compensacion_v1', 'Incidente operativo {{1}}: la persona regresó después del desplazamiento. Quedó registrado el reconocimiento de COP 30.000 por desplazamiento. Este aviso no ejecuta el pago.']
});
const documentHeaderTemplates = new Set(['payment_evidence_owner_reconciliation']);

function normalizedRecipient(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  return digits;
}

function destinationReferenceHash(value) {
  return crypto.createHash('sha256').update(normalizedRecipient(value)).digest('hex').toUpperCase();
}

function providerReferenceHash(value) {
  if (!value) throw Object.assign(new Error('provider_reference_missing'), { code: 'provider_reference_missing' });
  return crypto.createHash('sha256').update(String(value)).digest('hex').toUpperCase();
}

function renderSessionBody(body, parameters) {
  if (!body) throw Object.assign(new Error('session_body_not_supported'), { code: 'session_body_not_supported' });
  return body.replace(/\{\{(\d+)\}\}/g, (_, index) => String(parameters[Number(index) - 1]));
}

class SupervisedOutboundAdapter {
  constructor({ pms, sendSessionText, sendTemplate, logger = console }) {
    this.pms = pms;
    this.sendSessionText = sendSessionText;
    this.sendTemplate = sendTemplate;
    this.logger = logger;
  }

  async rejectClaim(claim, failureCode) {
    await this.pms.recordSupervisedDeliveryStatus({
      delivery_id: claim.delivery_id,
      status: 'failed',
      provider_reference_hash: null,
      failure_code: failureCode
    });
  }

  async deliver({ claim, recipient }) {
    if (!claim || !Number.isInteger(Number(claim.delivery_id))) {
      throw Object.assign(new Error('supervised_claim_required'), { code: 'supervised_claim_required' });
    }
    const phone = normalizedRecipient(recipient);
    if (destinationReferenceHash(phone) !== claim.destination_reference_hash) {
      await this.rejectClaim(claim, 'DESTINATION_MISMATCH');
      throw Object.assign(new Error('supervised_destination_mismatch'), { code: 'supervised_destination_mismatch' });
    }
    const template = templates[claim.template_key];
    if (!template) {
      await this.rejectClaim(claim, 'TEMPLATE_NOT_SUPPORTED');
      throw Object.assign(new Error('supervised_template_not_supported'), { code: 'supervised_template_not_supported' });
    }
    if (claim.delivery_mode === 'template' && documentHeaderTemplates.has(claim.template_key)
      && !claim.payload?.support_asset_id) {
      await this.rejectClaim(claim, 'DOCUMENT_HEADER_NOT_AVAILABLE');
      throw Object.assign(new Error('supervised_document_header_not_available'), {
        code: 'supervised_document_header_not_available'
      });
    }
    if (claim.delivery_mode === 'session' && !template[1]) {
      await this.rejectClaim(claim, 'SESSION_BODY_NOT_SUPPORTED');
      throw Object.assign(new Error('session_body_not_supported'), { code: 'session_body_not_supported' });
    }
    const authorization = await this.pms.beginSupervisedSubmission(claim.delivery_id);
    if (documentHeaderTemplates.has(claim.template_key) && !authorization.document_provider_reference) {
      try { await this.pms.markSupervisedSubmissionUnknown(claim.delivery_id, authorization.submission_attempt_hash); } catch {}
      throw Object.assign(new Error('supervised_document_reference_not_authorized'), {
        code: 'supervised_document_reference_not_authorized'
      });
    }
    try {
      const providerId = authorization.delivery_mode === 'template'
        ? await this.sendTemplate(phone, template[0], authorization.template_parameters,
          authorization.document_provider_reference || null)
        : await this.sendSessionText(phone, renderSessionBody(template[1], authorization.template_parameters));
      return await this.pms.completeSupervisedSubmission(claim.delivery_id, {
        submission_attempt_hash: authorization.submission_attempt_hash,
        provider_reference_hash: providerReferenceHash(providerId)
      });
    } catch (error) {
      try {
        await this.pms.markSupervisedSubmissionUnknown(claim.delivery_id, authorization.submission_attempt_hash);
      } catch (reconcileError) {
        this.logger.error('[supervised-outbound] unknown_state_persistence_failed', {
          delivery_id: String(claim.delivery_id), code: String(reconcileError?.code || 'persistence_failed')
        });
      }
      throw Object.assign(new Error('supervised_submission_result_unknown'), {
        code: 'supervised_submission_result_unknown', cause: error
      });
    }
  }
}

module.exports = {
  SupervisedOutboundAdapter,
  destinationReferenceHash,
  providerReferenceHash,
  renderSessionBody,
  templates
};
