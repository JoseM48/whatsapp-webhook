'use strict';

const axios = require('axios');
const { PmsPilotClient } = require('../lib/pilot/pms-client');
const { PilotAi } = require('../lib/pilot/ai');
const { PilotOrchestrator } = require('../lib/pilot/orchestrator');

async function main() {
  const secret = process.env.PMS_LITE_WEBHOOK_SECRET;
  if (!secret) throw new Error('local_test_secret_missing');
  const baseUrl = process.env.PMS_LITE_BASE_URL || 'http://127.0.0.1:3040';
  const pms = new PmsPilotClient({
    http: axios,
    baseUrl,
    inboundUrl: `${baseUrl}/api/integrations/whatsapp/inbound`,
    secret,
    publicBaseUrl: baseUrl,
    timeoutMs: 5000
  });
  const ai = new PilotAi({ http: { post: async () => { throw new Error('forced_fallback'); } }, apiKey: 'test' });
  const sent = [];
  const orchestrator = new PilotOrchestrator({
    pms, ai, brainSync: null,
    sendImage: async (_to, url) => {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
      if (response.status !== 200 || !String(response.headers['content-type'] || '').startsWith('image/') || response.data.length < 1000) {
        throw new Error('signed_media_delivery_failed');
      }
      sent.push({ type: 'image', url_path: new URL(url).pathname });
    },
    sendText: async (_to, text) => { sent.push({ type: 'text', length: text.length }); return 'wamid.synthetic.outbound'; },
    logger: { info() {}, warn() {}, error() {} }
  });
  const messageId = `wamid.synthetic.e2e.${Date.now()}`;
  await orchestrator.capture({
    from: '570000000777',
    text: 'Busco del 2026-08-01 al 2026-08-05 para 2 personas con balcón',
    messageId,
    timestamp: new Date().toISOString(),
    name: 'Lead Sintético E2E'
  });
  const result = await orchestrator.processCaptured({
    from: '570000000777',
    text: 'Busco del 2026-08-01 al 2026-08-05 para 2 personas con balcón',
    messageId,
    today: '2026-07-22'
  });
  if (!result.ok) throw new Error(`local_e2e_failed:${result.code}`);
  if (!sent.some((item) => item.type === 'text')) throw new Error('local_e2e_text_not_sent');
  if (!sent.some((item) => item.type === 'image')) throw new Error('local_e2e_image_not_sent');
  console.log(JSON.stringify({ ok: true, message_id_present: true, outbound: sent.map((item) => item.type) }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
