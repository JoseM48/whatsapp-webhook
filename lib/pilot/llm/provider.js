'use strict';

// Adapter de proveedor LLM -- Bloque B.
//
// Existe porque toda la dependencia de proveedor del sistema cabia en un solo
// metodo de 12 lineas (PilotAi.structured). Esto lo convierte en una interfaz
// con dos implementaciones, sin tocar interpret()/redact()/present().
//
// Contrato unico:
//   structured({ schema, system, input, tools, toolResults, timeoutMs })
//     -> { output, tool_calls, usage, meta }
//
// Diferencias que el adapter absorbe, y que NO deben filtrarse hacia arriba:
//   - Anthropic no acepta minLength/maxLength/minimum/maximum/multipleOf/
//     minItems/maxItems dentro del schema (confirmado por un 400 real en
//     produccion, 2026-09-10). OpenAI si los acepta.
//   - Anthropic devuelve bloques `content[]` con type text|tool_use.
//     OpenAI devuelve `output[]` con otra forma.
//   - Anthropic expone el error en error.status/.type; OpenAI/axios lo
//     esconden en error.response.data.error.
//
// TIMEOUT: obligatorio en ambos. El adaptador anterior de OpenAI tenia
// timeout: 20000; la migracion a Anthropic lo perdio y hoy produccion corre
// sin ninguno. Aqui es un parametro del contrato, no un detalle opcional.

const DEFAULT_TIMEOUT_MS = 20000;

// Claves de JSON Schema que Anthropic rechaza. Se filtran solo en el camino
// hacia la API: el schema original sigue documentando el contrato real.
const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems'
]);

function stripUnsupported(schema, unsupported) {
  if (Array.isArray(schema)) return schema.map((item) => stripUnsupported(item, unsupported));
  if (!schema || typeof schema !== 'object') return schema;
  const clean = {};
  for (const [key, value] of Object.entries(schema)) {
    if (unsupported.has(key)) continue;
    clean[key] = stripUnsupported(value, unsupported);
  }
  return clean;
}

// Error normalizado: la capa de arriba nunca debe preguntar de que proveedor
// viene. `retryable` distingue un 429/503 de un 400 por schema invalido, que
// reintentar no arregla.
class LlmError extends Error {
  constructor({ provider, status, code, retryable, message }) {
    super(message || code || 'llm_request_failed');
    this.name = 'LlmError';
    this.provider = provider;
    this.status = status ?? null;
    this.code = code || 'llm_request_failed';
    this.retryable = Boolean(retryable);
  }
}

function classify(provider, status, rawCode) {
  const code = String(rawCode || 'unknown').replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 100);
  // 408/429 y toda la familia 5xx son transitorios. 400/401/403/404 no lo son:
  // reintentar un schema invalido solo gasta dinero.
  const retryable = status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
  return new LlmError({ provider, status: status ?? null, code, retryable });
}

// Aborta de verdad la peticion, no solo la promesa: sin esto una llamada lenta
// sigue consumiendo la conexion aunque arriba ya se haya rendido.
async function withTimeout(promiseFactory, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promiseFactory(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LlmError({ provider, status: 408, code: 'llm_timeout', retryable: true,
        message: `timeout after ${timeoutMs}ms` });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class AnthropicProvider {
  constructor({ client, apiKey, model = 'claude-sonnet-5' } = {}) {
    this.name = 'anthropic';
    this.model = model;
    this.client = client || null;
    this.apiKey = apiKey;
  }

  ensureClient() {
    if (this.client) return this.client;
    const Anthropic = require('@anthropic-ai/sdk');
    this.client = new Anthropic(this.apiKey ? { apiKey: this.apiKey } : undefined);
    return this.client;
  }

  async structured({ schema, system, input, tools, toolResults, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const client = this.ensureClient();
    const startedAt = Date.now();

    const messages = [{ role: 'user', content: input }];
    // Continuacion del lazo de tools: se reenvia el turno del asistente con sus
    // tool_use y, a continuacion, los tool_result. Es el formato que exige la
    // API y el unico que preserva la correspondencia por id.
    if (Array.isArray(toolResults) && toolResults.length) {
      messages.push({ role: 'assistant', content: toolResults.map((r) => r.assistantBlock).filter(Boolean) });
      messages.push({ role: 'user', content: toolResults.map((r) => ({
        type: 'tool_result', tool_use_id: r.tool_use_id, content: JSON.stringify(r.result)
      })) });
    }

    const request = { model: this.model, max_tokens: 4096, system, messages };
    if (tools && tools.length) {
      request.tools = tools.map((t) => ({
        name: t.name, description: t.description,
        input_schema: stripUnsupported(t.parameters, ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS)
      }));
    }
    if (schema) {
      request.output_config = { format: { type: 'json_schema',
        schema: stripUnsupported(schema, ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS) } };
    }

    let response;
    try {
      response = await withTimeout(
        (signal) => client.messages.create(request, { signal }),
        timeoutMs, this.name
      );
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw classify(this.name, Number(error?.status) || null, error?.type || error?.code || error?.name);
    }

    const blocks = response?.content || [];
    const textBlock = blocks.find((b) => b?.type === 'text');
    const toolUse = blocks.filter((b) => b?.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input, _raw: b }));

    let output = null;
    if (!toolUse.length && typeof textBlock?.text === 'string') {
      try { output = schema ? JSON.parse(textBlock.text) : textBlock.text; }
      catch { throw classify(this.name, null, 'llm_output_not_json'); }
    }

    return {
      output, tool_calls: toolUse, stop_reason: response?.stop_reason ?? null,
      usage: {
        input_tokens: response?.usage?.input_tokens ?? null,
        output_tokens: response?.usage?.output_tokens ?? null
      },
      meta: { provider: this.name, model: this.model, latency_ms: Date.now() - startedAt }
    };
  }
}

class OpenAiProvider {
  // Reconstruido desde el adaptador que existia antes del commit 959428f
  // ("Switch PilotAi from OpenAI to the Anthropic API"): mismo endpoint, mismo
  // formato de schema estricto y el timeout de 20 s que aquel si tenia.
  constructor({ http, apiKey, model = 'gpt-5.6-luna' } = {}) {
    this.name = 'openai';
    this.model = model;
    this.apiKey = apiKey;
    this.http = http || null;
  }

  ensureHttp() {
    if (this.http) return this.http;
    this.http = require('axios');
    return this.http;
  }

  async structured({ schema, system, input, tools, toolResults, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const http = this.ensureHttp();
    const startedAt = Date.now();
    if (!this.apiKey) throw classify(this.name, null, 'openai_api_key_missing');

    const messageInput = [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: input }] }
    ];
    if (Array.isArray(toolResults) && toolResults.length) {
      // La Responses API exige reenviar el `function_call` ORIGINAL del
      // asistente antes de su `function_call_output`. Mandar solo el output
      // devuelve 400: confirmado contra la API real el 2026-09-21, y es la
      // causa por la que el lazo de tools fallaba en los cuatro casos de
      // referencia mientras la primera llamada funcionaba sola.
      for (const r of toolResults) {
        if (r.assistantBlock) messageInput.push(r.assistantBlock);
        messageInput.push({ type: 'function_call_output', call_id: r.tool_use_id,
          output: JSON.stringify(r.result) });
      }
    }

    const body = { model: this.model, store: false, input: messageInput };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', name: t.name,
        description: t.description, parameters: t.parameters, strict: false }));
    }
    if (schema) {
      body.text = { format: { type: 'json_schema', name: 'interpretation', strict: true, schema } };
    }

    let response;
    try {
      response = await http.post('https://api.openai.com/v1/responses', body, {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        timeout: timeoutMs
      });
    } catch (error) {
      const status = Number(error?.response?.status) || null;
      if (error?.code === 'ECONNABORTED') {
        throw new LlmError({ provider: this.name, status: 408, code: 'llm_timeout', retryable: true });
      }
      throw classify(this.name, status, error?.response?.data?.error?.code || error?.code);
    }

    const items = response?.data?.output || [];
    const toolUse = items.filter((i) => i?.type === 'function_call')
      .map((i) => ({ id: i.call_id, name: i.name,
        arguments: (() => { try { return JSON.parse(i.arguments); } catch { return {}; } })(), _raw: i }));
    const textItem = items.find((i) => i?.type === 'message');
    const rawText = textItem?.content?.find((c) => c?.type === 'output_text')?.text;

    let output = null;
    if (!toolUse.length && typeof rawText === 'string') {
      try { output = schema ? JSON.parse(rawText) : rawText; }
      catch { throw classify(this.name, null, 'llm_output_not_json'); }
    }

    return {
      output, tool_calls: toolUse, stop_reason: response?.data?.status ?? null,
      usage: {
        input_tokens: response?.data?.usage?.input_tokens ?? null,
        output_tokens: response?.data?.usage?.output_tokens ?? null
      },
      meta: { provider: this.name, model: this.model, latency_ms: Date.now() - startedAt }
    };
  }
}

// Seleccion por configuracion. Default `anthropic` = lo que corre hoy en
// produccion: encender esta pieza sin tocar LLM_PROVIDER no cambia nada.
function createLlmProvider(env = process.env, overrides = {}) {
  const choice = String(env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  if (choice === 'openai') {
    return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY,
      model: (env.PILOT_OPENAI_MODEL || 'gpt-5.6-luna').trim(), ...overrides });
  }
  if (choice !== 'anthropic') throw new LlmError({ provider: choice, code: 'llm_provider_unknown' });
  return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY,
    model: (env.PILOT_ANTHROPIC_MODEL || 'claude-sonnet-5').trim(), ...overrides });
}

module.exports = {
  createLlmProvider, AnthropicProvider, OpenAiProvider, LlmError,
  DEFAULT_TIMEOUT_MS, stripUnsupported, ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS
};
