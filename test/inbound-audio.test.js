'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InboundAudioTranscriber, extensionForMimeType } = require('../lib/pilot/inbound-audio');

function fakeHttp({ mediaUrl = 'https://media.example/audio.ogg', mimeType = 'audio/ogg', bytes = Buffer.from('fake-audio-bytes') } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url, config) => {
      calls.push({ url, headers: config?.headers, responseType: config?.responseType });
      if (url.startsWith('https://graph.facebook.com')) {
        return { data: { url: mediaUrl, mime_type: mimeType } };
      }
      if (url === mediaUrl) {
        return { data: bytes };
      }
      throw new Error(`unexpected_url:${url}`);
    }
  };
}

function fakeOpenai(text = 'hola quiero el apartamento por tres meses') {
  const calls = [];
  return {
    calls,
    audio: { transcriptions: { create: async (params) => { calls.push(params); return { text }; } } }
  };
}

function fakeToFile() {
  const calls = [];
  const toFile = async (buffer, filename, options) => { calls.push({ buffer, filename, options }); return { buffer, filename }; };
  toFile.calls = calls;
  return toFile;
}

test('descarga el audio en dos pasos con el mismo Bearer token y transcribe con OpenAI', async () => {
  const http = fakeHttp();
  const openai = fakeOpenai('hola quiero el apartamento por tres meses');
  const toFile = fakeToFile();
  const transcriber = new InboundAudioTranscriber({ http, openai, toFile, accessToken: 'test-token' });

  const text = await transcriber.transcribe('media.1');

  assert.equal(text, 'hola quiero el apartamento por tres meses');
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, 'https://graph.facebook.com/v20.0/media.1');
  assert.equal(http.calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(http.calls[1].url, 'https://media.example/audio.ogg');
  assert.equal(http.calls[1].headers.Authorization, 'Bearer test-token');
  assert.equal(http.calls[1].responseType, 'arraybuffer');
  assert.equal(toFile.calls.length, 1);
  assert.equal(toFile.calls[0].filename, 'inbound-audio.ogg');
  assert.equal(toFile.calls[0].options.type, 'audio/ogg');
  assert.equal(openai.calls.length, 1);
  assert.equal(openai.calls[0].model, 'whisper-1');
});

test('rechaza sin id de medio', async () => {
  const transcriber = new InboundAudioTranscriber({ http: fakeHttp(), openai: fakeOpenai(), toFile: fakeToFile(), accessToken: 'x' });
  await assert.rejects(() => transcriber.transcribe(null), /inbound_audio_media_id_required/);
});

test('propaga el error si Meta no devuelve una URL de medio', async () => {
  const http = { get: async () => ({ data: {} }) };
  const transcriber = new InboundAudioTranscriber({ http, openai: fakeOpenai(), toFile: fakeToFile(), accessToken: 'x' });
  await assert.rejects(() => transcriber.transcribe('media.1'), /inbound_audio_media_url_missing/);
});

test('propaga el error si la transcripción vuelve vacía en vez de inventar texto', async () => {
  const http = fakeHttp();
  const openai = fakeOpenai('   ');
  const transcriber = new InboundAudioTranscriber({ http, openai, toFile: fakeToFile(), accessToken: 'x' });
  await assert.rejects(() => transcriber.transcribe('media.1'), /inbound_audio_transcription_empty/);
});

test('propaga el error si la descarga del binario viene vacía', async () => {
  const http = fakeHttp({ bytes: Buffer.alloc(0) });
  const transcriber = new InboundAudioTranscriber({ http, openai: fakeOpenai(), toFile: fakeToFile(), accessToken: 'x' });
  await assert.rejects(() => transcriber.transcribe('media.1'), /inbound_audio_empty_download/);
});

test('exige las tres dependencias inyectadas', () => {
  assert.throws(() => new InboundAudioTranscriber({ openai: fakeOpenai(), toFile: fakeToFile() }), /inbound_audio_http_required/);
  assert.throws(() => new InboundAudioTranscriber({ http: fakeHttp(), toFile: fakeToFile() }), /inbound_audio_openai_required/);
  assert.throws(() => new InboundAudioTranscriber({ http: fakeHttp(), openai: fakeOpenai() }), /inbound_audio_tofile_required/);
});

test('deriva la extensión del archivo a partir del mime type de Meta', () => {
  assert.equal(extensionForMimeType('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionForMimeType('audio/mp4'), 'm4a');
  assert.equal(extensionForMimeType('audio/mpeg'), 'mp3');
  assert.equal(extensionForMimeType('audio/amr'), 'amr');
  assert.equal(extensionForMimeType('audio/wav'), 'wav');
  assert.equal(extensionForMimeType(null), 'ogg');
  assert.equal(extensionForMimeType('application/octet-stream'), 'ogg');
});
