'use strict';

const { normalizePhone, isAllowlisted } = require('./security');
const { portadaUrl, galleryUrls } = require('./apartment-photos');
const { resolveNaturalPresentation } = require('./m0-natural-presentation');

function closedError(code) { return Object.assign(new Error(code), { code }); }

function validateClosedPilotConfig(config) {
  const internal = normalizePhone(config.internalPhone);
  const templateConfigured = /^[a-z0-9_]{3,512}$/.test(String(config.internalTemplateName || '')) &&
    /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(String(config.internalTemplateLanguage || ''));
  if (!config.enabled) return { enabled: false, ready: false, receipts_enabled: config.receiptsEnabled === true,
    internal_template_configured: templateConfigured };
  // The guest side is deliberately open: any phone that is not the internal/staff
  // number is treated as a guest. Only the internal (staff) number stays gated —
  // it is the sole recipient allowed for internal-role escalations and commands.
  if (!internal || !config.metaSignatureRequired ||
    !config.pmsM0Enabled || !config.controlledIngressEnabled || !config.pmsConfigured ||
    config.receiptsEnabled !== true || !templateConfigured) throw closedError('m0_closed_webhook_configuration_invalid');
  return { enabled: true, ready: true, internal, receipts_enabled: true,
    internal_template_configured: true, internalTemplateName: config.internalTemplateName,
    internalTemplateLanguage: config.internalTemplateLanguage };
}

function uncertain(error) {
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'provider_reference_missing'].includes(error?.code) ||
    Number(error?.response?.status) >= 500 || /timeout/i.test(error?.message || '');
}

function normalizedCommand(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

// WhatsApp template parameters reject embedded newlines/tabs and 4+
// consecutive spaces. The internal message body is intentionally allowed to
// span multiple lines (it is readable in the outbox/audit trail), so it must
// be flattened here, right before it becomes a template parameter — not
// scattered across every place in PMS that builds one.
function sanitizeTemplateParameter(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function internalTemplateParameters(message) {
  const match = String(message || '').match(/^PILOTO M0\nPARA: ([^\n]+)\nCASO: ([^\n]+)\nAPARTAMENTO: ([^\n]+)\nACCIÓN SOLICITADA: ([^\n]+)\n\n([\s\S]+)$/);
  if (!match) throw closedError('m0_closed_internal_template_payload_invalid');
  return match.slice(1).map(sanitizeTemplateParameter);
}

// Two independent triggers, matched only against guest-facing plain text:
// - a proposal line ("LF-210: COP ...") gets just its portada, automatically;
// - a message PMS Lite explicitly flagged message_kind:'photos' (the guest
//   asked to see more) gets the full gallery for every apartment it names.
function apartmentPhotosToSend(claim) {
  const text = String(claim?.message_text || '');
  if (claim?.message_kind === 'photos') {
    const codes = [...new Set(text.match(/\bLF-\d{3,4}\b/g) || [])];
    return codes.flatMap((code) => galleryUrls(code));
  }
  const codes = [...new Set((text.match(/\bLF-\d{3,4}(?=:\s*COP)/g) || []))];
  return codes.map((code) => portadaUrl(code)).filter(Boolean);
}

function createM0ClosedPilotDispatcher({ config, pms, sendText, sendTemplate, sendFlow, sendPhoto, logger = console,
  // Incremento D3.3 (2026-09-03): dependencia nueva y opcional -- la
  // instancia de PilotAi que sabe redactar (PilotAi.redact()). Nunca se usa
  // salvo que config.naturalPresentationEnabled sea true Y esta dependencia
  // exista; ausente por defecto en cualquier llamada que no la pase
  // explicitamente, exactamente como hoy.
  redactionAi = null }) {
  const status = validateClosedPilotConfig(config);
  const flowReady = Boolean(config.flow?.enabled && config.flow?.flowId && sendFlow);
  // Incremento D3.3: bandera de entorno, default seguro OFF (ver
  // m0-natural-presentation.js) -- leida una sola vez al construir el
  // dispatcher, mismo patron ya usado para config.flow.restrictToTestPhones.
  const naturalPresentationEnabled = config.naturalPresentationEnabled === true;
  async function deliver(outbox, { packet = null } = {}) {
    const claim = await pms.claimClosedPilotOutbound(outbox.id);
    if (!claim?.claimable) return { id: outbox.id, status: claim?.status || 'not_claimable', sent: false };
    // Guest recipients are resolved per-conversation by PMS (real phone of the
    // lead behind that case), never a fixed configured value. Internal recipients
    // stay pinned to the single configured staff number.
    const recipient = claim.recipient_kind === 'guest' ? normalizePhone(claim.recipient_phone || '')
      : claim.recipient_kind === 'internal' ? status.internal : null;
    const recipientValid = claim.recipient_kind === 'internal' ? recipient === status.internal
      : claim.recipient_kind === 'guest' ? Boolean(recipient) && recipient.length >= 10 : false;
    if (!recipientValid) throw closedError('m0_closed_recipient_missing_or_invalid');
    // A guest row asking for the flow only actually goes out as a Flow when one
    // is configured; otherwise it degrades to the same text question it would
    // have used before this feature existed. restrictToTestPhones is
    // independent of whether the Flow is published -- Meta's send API only
    // accepts published Flows (there is no "draft" send parameter, confirmed
    // by a live 400 "Unexpected key" response), so this is the only gate
    // keeping the Flow limited to authorized test phones while it is new.
    const flowTestGateOpen = !config.flow?.restrictToTestPhones || isAllowlisted(recipient, config.flow?.testAllowlist || []);
    const useFlow = claim.recipient_kind === 'guest' && claim.message_kind === 'flow' && flowReady && flowTestGateOpen;
    // Incremento D3.3 (2026-09-03): guestText es lo que de verdad se envia
    // al huesped -- claim.message_text (deterministico) salvo que la
    // bandera este ON, exista un packet para este turno y este candidato de
    // IA haya pasado el validador de D3.2. Con la bandera OFF (default) o
    // sin packet/redactionAi, este bloque nunca corre: guestText es siempre
    // claim.message_text, cero llamadas nuevas, comportamiento identico al
    // de antes de D3.3. apartmentPhotosToSend() y el mensaje interno siguen
    // leyendo claim.message_text sin cambios -- solo el texto que se manda
    // por WhatsApp al huesped puede diferir.
    let guestText = claim.message_text;
    // Canary (2026-09-04): la bandera maestra M0_NATURAL_PRESENTATION_ENABLED
    // no tenia ningun filtro por telefono -- activarla encendia redaccion IA
    // para CUALQUIER huesped real de inmediato. Mismo patron ya usado para
    // el Flow (restrictToTestPhones/testAllowlist): default seguro
    // restringido, para poder activar la bandera maestra y aun asi limitar
    // el efecto real a los telefonos de prueba mientras se valida en
    // produccion.
    const naturalPresentationTestGateOpen = !config.naturalPresentationRestrictToTestPhones ||
      isAllowlisted(recipient, config.naturalPresentationTestAllowlist || []);
    if (naturalPresentationEnabled && naturalPresentationTestGateOpen && redactionAi && packet && claim.recipient_kind === 'guest' && claim.message_kind !== 'photos') {
      const presentation = await resolveNaturalPresentation({
        packet, phone: recipient, ai: redactionAi, pms, enabled: true, logger
      });
      guestText = presentation.text ?? claim.message_text;
      // Trazabilidad minima (D3.3): solo log estructurado, sin persistir
      // el candidato rechazado ni ampliar retencion de datos -- ver
      // seccion de trazabilidad del cierre de este incremento.
      logger.info('[m0-closed] natural_presentation', {
        outbox_id: outbox.id, presentation_source: presentation.presentation_source,
        attempted: presentation.attempted, latency_ms: presentation.latency_ms,
        model: presentation.model, failure_reasons: presentation.failure_reasons
      });
    }
    let providerReference = null;
    try {
      providerReference = claim.recipient_kind === 'internal'
        ? await sendTemplate(recipient, { name: status.internalTemplateName,
          language: status.internalTemplateLanguage, parameters: internalTemplateParameters(claim.message_text) })
        : useFlow
          ? await sendFlow(recipient, { flowId: config.flow.flowId, flowToken: `${claim.outbox_id}`,
            firstScreen: config.flow.firstScreen, ctaText: 'Continuar', bodyText: guestText })
          : await sendText(recipient, guestText);
      if (!providerReference) throw closedError('provider_reference_missing');
      // Photos are a best-effort enhancement on top of an already-delivered
      // message: a failure here must never flip a successfully sent outbox
      // row to 'failed' or retry it, so it is logged and swallowed, not thrown.
      if (sendPhoto && claim.recipient_kind === 'guest' && !useFlow) {
        for (const url of apartmentPhotosToSend(claim)) {
          try { await sendPhoto(recipient, url); }
          catch (photoError) { logger.error('[m0-closed] photo_delivery_failed', {
            url, code: photoError?.code || photoError?.message || 'unknown',
            http_status: photoError?.response?.status || null,
            meta_error: photoError?.response?.data?.error?.message || null,
            meta_error_details: photoError?.response?.data?.error?.error_data?.details || null }); }
        }
      }
      await pms.completeClosedPilotOutbound({ outbox_id: claim.outbox_id, status: 'submitted',
        provider_reference: providerReference });
      return { id: outbox.id, status: 'submitted', sent: true };
    } catch (error) {
      const state = providerReference || uncertain(error) ? 'unknown' : 'failed';
      try { await pms.completeClosedPilotOutbound({ outbox_id: claim.outbox_id, status: state }); }
      catch (persistenceError) { logger.error('[m0-closed] outbound_state_persistence_failed', { state,
        code: persistenceError?.code || 'persistence_failed' }); }
      throw error;
    }
  }
  async function deliverAll(outboxes = [], options = {}) {
    const deliveries = [];
    for (const outbox of outboxes) deliveries.push(await deliver(outbox, options));
    return deliveries;
  }
  async function deliverAllSafe(outboxes = [], options = {}) {
    const deliveries = [];
    for (const outbox of outboxes) {
      try { deliveries.push(await deliver(outbox, options)); }
      catch (error) {
        // Meta's error body (message/code, no secrets or guest content) is
        // logged so a rejected send is diagnosable without re-deriving it
        // from scratch next time.
        logger.error('[m0-commercial] outbound_failed_after_durable_capture', {
          outbox_id: outbox.id, code: error?.code || 'commercial_outbound_failed',
          http_status: error?.response?.status || null,
          meta_error: error?.response?.data?.error?.message || error?.response?.data?.error?.error_data?.details || null
        });
        deliveries.push({ id: outbox.id, status: 'failed_or_unknown', sent: false,
          error_code: error?.code || 'commercial_outbound_failed' });
      }
    }
    return deliveries;
  }
  return {
    status: () => ({ ...status, internal: undefined,
      internalTemplateName: undefined, internalTemplateLanguage: undefined }),
    // Anyone who is not the internal/staff number is accepted as a guest.
    // PMS enforces the real gates: runtime state, cohort enrollment and cap,
    // and the apartment scope — this is only a cheap routing check.
    accepts(phone) { const value = normalizePhone(phone); return status.enabled && Boolean(value); },
    isControl(phone, text) {
      if (!status.enabled) return false;
      const value = normalizePhone(phone);
      if (value === status.internal) return true;
      const command = normalizedCommand(text);
      return command === 'NUEVA PRUEBA' || command === 'REINICIAR CASO' || command.startsWith('ESTADO CASO');
    },
    async beginCommercial({ phone, messageId, occurredAt, deliver = true }) {
      const normalizedPhone = normalizePhone(phone);
      if (!status.enabled) return { handled: false, deliveries: [] };
      if (!normalizedPhone) return { handled: true, quarantined: true, deliveries: [] };
      if (!messageId) throw closedError('m0_closed_message_id_required');
      const result = await pms.beginClosedPilotCommercial({ phone: normalizedPhone,
        external_message_id: messageId, occurred_at: occurredAt });
      return { handled: true, quarantined: false, result,
        deliveries: deliver ? await deliverAllSafe(result?.outboxes || []) : [] };
    },
    deliverCommercialOutboxes(outboxes) { return deliverAllSafe(outboxes); },
    async completeCommercial({ externalMessageId, interpretation, ai }) {
      const result = await pms.processClosedPilotCommercial({ external_message_id: externalMessageId,
        interpretation, ai });
      // Incremento D3.3: unico punto donde authorized_response_packet (D3.1)
      // se hace disponible para la entrega -- deliver() decide si lo usa,
      // segun la bandera y si existe redactionAi (ver arriba).
      return { handled: true, result, deliveries: await deliverAllSafe(result?.outboxes || [],
        { packet: result?.authorized_response_packet || null }) };
    },
    async process({ phone, text, messageId, occurredAt }) {
      if (!status.enabled) return { handled: false };
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) return { handled: true, quarantined: true, deliveries: [] };
      if (!messageId) throw closedError('m0_closed_message_id_required');
      const result = await pms.closedPilotInbound({ phone: normalizedPhone, text,
        external_message_id: messageId, occurred_at: occurredAt });
      const deliveries = await deliverAll(result?.outboxes || []);
      return { handled: true, quarantined: false, result, deliveries };
    }
  };
}

module.exports = { createM0ClosedPilotDispatcher, validateClosedPilotConfig, internalTemplateParameters };
