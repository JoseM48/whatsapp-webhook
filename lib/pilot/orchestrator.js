'use strict';

function safeErrorCode(error, fallback = 'pilot_error') {
  const status = error?.response?.status;
  if (status === 429) return 'dependency_rate_limited';
  if (status >= 500) return 'dependency_unavailable';
  if (error?.code === 'ECONNABORTED') return 'dependency_timeout';
  return String(error?.code || fallback).replace(/[^a-z0-9_:-]/gi, '_').slice(0, 100);
}

function safeSheetCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

class PilotOrchestrator {
  constructor({ pms, ai, brainSync, sendText, sendImage, context = {}, logger = console }) {
    this.pms = pms; this.ai = ai; this.brainSync = brainSync;
    this.sendText = sendText; this.sendImage = sendImage; this.context = context; this.logger = logger;
  }

  async capture({ from, text, messageId, timestamp, name }) {
    const conversationKey = typeof this.context.conversationKey === 'function'
      ? this.context.conversationKey(from)
      : this.context.conversationKey;
    return this.pms.capture({
      telefono: from, nombre: name || undefined, mensaje: text, timestamp,
      external_message_id: messageId, origen: 'whatsapp_oficial_pilot_controlado',
      organization_key: this.context.organizationKey || 'versadaa',
      vertical_key: this.context.verticalKey || 'alojamientos_la_frontera',
      channel_key: this.context.channelKey || 'whatsapp',
      channel_account_key: this.context.channelAccountKey || null,
      conversation_key: conversationKey || null,
      sender_role: 'prospect',
      property_key: null
    });
  }

  async syncOperationalLead({ from, text, interpretation }) {
    if (!this.brainSync) return { skipped: true };
    try {
      await this.brainSync({
        Telefono: from,
        Mensaje_Original: safeSheetCell(text),
        Personas: interpretation.guests || '',
        Fecha_Inicio: interpretation.check_in || '',
        Duracion: interpretation.nights ? `${interpretation.nights} noches` : '',
        Tipo_Lead: 'PILOTO_LA_FRONTERA', Estado: 'NUEVO', Origen: 'WhatsApp',
        Notas: 'Disponibilidad y precio pendientes de confirmación operativa.'
      });
      return { ok: true };
    } catch (error) {
      this.logger.warn('[pilot] operational_lead_sync_failed', { code: safeErrorCode(error, 'brain_sync_failed') });
      return { ok: false };
    }
  }

  async processCaptured({ from, text, messageId, today }) {
    try {
      const interpretation = await this.ai.interpret({ text, phone: from, today });
      await this.syncOperationalLead({ from, text, interpretation });
      const decision = await this.pms.decide({ external_message_id: messageId, interpretation });
      const presentation = await this.ai.present({ decision, phone: from });
      const verified = await this.pms.verify({
        external_message_id: messageId,
        context_hash: decision.context_hash,
        text: presentation.text,
        selected_item_ids: presentation.selected_item_ids,
        selected_media_ids: presentation.selected_media_ids
      });
      return this.deliverClaimed({ outboxId: verified.outbox_id, recipient: from });
    } catch (error) {
      const code = safeErrorCode(error);
      try { await this.pms.processingFailure({ external_message_id: messageId, error_code: code, retryable: true }); } catch {}
      this.logger.error('[pilot] processing_failed', { message_id_present: Boolean(messageId), code });
      return { ok: false, code };
    }
  }

  async deliverClaimed({ outboxId, recipient }) {
    const claimed = await this.pms.claim(outboxId);
    if (!claimed.claimed) return { ok: true, skipped: 'already_claimed' };
    const payload = claimed.payload;
    let deliveredParts = 0;
    try {
      for (const mediaId of payload.media_ids || []) {
        await this.sendImage(recipient, this.pms.mediaUrl(mediaId));
        deliveredParts += 1;
      }
      const metaMessageId = await this.sendText(recipient, payload.text);
      deliveredParts += 1;
      await this.pms.status({ outbox_id: outboxId, status: 'sent', meta_message_id: metaMessageId || null, error_code: null });
      this.logger.info('[pilot] outbound_sent', { outbox_id: String(outboxId), media_count: (payload.media_ids || []).length });
      return { ok: true };
    } catch (error) {
      const code = safeErrorCode(error, 'whatsapp_send_failed');
      const uncertain = error?.code === 'ECONNABORTED' || String(error?.message || '').toLowerCase().includes('timeout');
      const partial = deliveredParts > 0;
      const retryable = !partial && !uncertain && (error?.response?.status === 429 || error?.response?.status >= 500);
      const finalCode = partial ? 'partial_delivery_unknown' : uncertain ? 'meta_delivery_unknown' : code;
      await this.pms.status({ outbox_id: outboxId, status: retryable ? 'retry_pending' : 'failed', meta_message_id: null, error_code: finalCode });
      this.logger.error('[pilot] outbound_failed', { outbox_id: String(outboxId), code: finalCode });
      return { ok: false, code };
    }
  }
}

module.exports = { PilotOrchestrator, safeErrorCode, safeSheetCell };
