'use strict';

const crypto = require('crypto');

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

class PmsPilotClient {
  constructor({ http, baseUrl, inboundUrl, secret, timeoutMs = 8000, publicBaseUrl = '', mediaSigningSecret = '' }) {
    this.http = http;
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.inboundUrl = inboundUrl;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.publicBaseUrl = String(publicBaseUrl || baseUrl || '').replace(/\/$/, '');
    this.mediaSigningSecret = mediaSigningSecret || secret;
  }

  async postUrl(url, body) {
    if (!url || !this.secret) throw Object.assign(new Error('pms_pilot_not_configured'), { code: 'pms_pilot_not_configured' });
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify(body);
    const response = await this.http.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-PMS-Timestamp': timestamp,
        'X-PMS-Signature': sign(this.secret, timestamp, rawBody)
      },
      timeout: this.timeoutMs
    });
    return response.data?.data;
  }

  post(path, body) { return this.postUrl(`${this.baseUrl}${path}`, body); }
  capture(body) { return this.postUrl(this.inboundUrl, body); }
  decide(body) { return this.post('/api/pilot/decision', body); }
  verify(body) { return this.post('/api/pilot/presentation/verify', body); }
  claim(outboxId) { return this.post('/api/pilot/outbound/claim', { outbox_id: outboxId }); }
  status(body) { return this.post('/api/pilot/outbound/status', body); }
  processingFailure(body) { return this.post('/api/pilot/processing/failure', body); }
  retryableProcessing(limit = 10) { return this.post('/api/pilot/processing/retryable', { limit }); }
  retryableOutbound(limit = 10) { return this.post('/api/pilot/outbound/retryable', { limit }); }
  async warmup(timeoutMs = 75_000) {
    if (!this.baseUrl) throw Object.assign(new Error('pms_pilot_not_configured'), { code: 'pms_pilot_not_configured' });
    const response = await this.http.get(`${this.baseUrl}/health`, { timeout: timeoutMs });
    if (response.status !== 200 || response.data?.service !== 'pms-lite') {
      throw Object.assign(new Error('pms_warmup_unhealthy'), { code: 'pms_warmup_unhealthy' });
    }
    return { status: response.status };
  }

  mediaUrl(mediaId, lifetimeSeconds = 600) {
    const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    const signature = crypto.createHmac('sha256', this.mediaSigningSecret).update(`${mediaId}.${expires}`).digest('hex');
    return `${this.publicBaseUrl}/media/pilot/${mediaId}?expires=${expires}&signature=${signature}`;
  }
}

module.exports = { PmsPilotClient, sign };
