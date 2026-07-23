'use strict';

async function runStartupPreflight({ http, pms, baseUrl, now = () => Date.now() }) {
  const origin = new URL(baseUrl).origin;
  if (new URL(origin).protocol !== 'https:') {
    throw Object.assign(new Error('preflight_https_required'), { code: 'preflight_https_required' });
  }

  const health = await http.get(`${origin}/health`, { timeout: 10000 });
  if (health.status !== 200 || health.data?.service !== 'pms-lite') {
    throw Object.assign(new Error('preflight_health_failed'), { code: 'preflight_health_failed' });
  }

  const externalMessageId = `render-startup-preflight-${now()}`;
  const message = {
    telefono: 'synthetic-render-preflight',
    nombre: 'Synthetic Render Preflight',
    mensaje: 'Synthetic connectivity preflight. No reply.',
    timestamp: new Date(now()).toISOString(),
    external_message_id: externalMessageId,
    origen: 'codex_render_startup_preflight',
    organization_key: 'versadaa',
    vertical_key: 'alojamientos_la_frontera',
    channel_key: 'whatsapp',
    channel_account_key: 'synthetic-render-preflight',
    conversation_key: externalMessageId,
    sender_role: 'system_preflight',
    property_key: null
  };

  const first = await pms.capture(message);
  const duplicate = await pms.capture(message);
  const [processing, outbound] = await Promise.all([
    pms.retryableProcessing(1),
    pms.retryableOutbound(1)
  ]);

  const sameInteraction = String(first?.interaction?.id || '')
    === String(duplicate?.interaction?.id || '');
  if (first?.deduplicated !== false || duplicate?.deduplicated !== true || !sameInteraction) {
    throw Object.assign(new Error('preflight_deduplication_failed'), {
      code: 'preflight_deduplication_failed'
    });
  }

  return {
    ok: true,
    https_status: health.status,
    hmac_recovery_ok: Array.isArray(processing) && Array.isArray(outbound),
    first_capture_created: first.created_interaction === true,
    duplicate_controlled: duplicate.deduplicated === true,
    same_interaction: sameInteraction,
    outbound_attempts: 0,
    openai_calls: 0
  };
}

module.exports = { runStartupPreflight };
