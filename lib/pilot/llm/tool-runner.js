'use strict';

// Lazo de tools -- Bloque B.
//
// Reglas duras, y ninguna es opcional:
//   1. Tope de iteraciones. Un lazo sin tope es un incidente de coste
//      esperando a ocurrir, no una hipotesis.
//   2. Solo READ TOOLS. Si el modelo pide una action, se rechaza con
//      not_authorized y el lazo continua -- no se ejecuta ni se aborta.
//   3. Una tool que falla NO rompe el turno: devuelve error y el modelo decide
//      que hacer. Caer entero porque una consulta fallo es peor que responder
//      con lo que se tiene.
//   4. Cada llamada queda registrada: nombre, argumentos, status, latencia.

const { isReadTool, toolsForModel, toolResult, TOOL_STATUS } = require('./tools.js');

const MAX_ITERATIONS = 4;      // 4 rondas cubren resolver referencia -> disponibilidad -> cotizar
const MAX_CALLS_PER_TURN = 8;  // techo absoluto, independiente de las rondas

async function runToolLoop({ provider, schema, system, input, executor, traceRef,
  maxIterations = MAX_ITERATIONS, maxCalls = MAX_CALLS_PER_TURN, timeoutMs, logger = console }) {

  const trace = traceRef ? traceRef.trace : [];
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let toolResults = null;
  let iterations = 0;
  let totalCalls = 0;
  let stopReason = 'completed';

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await provider.structured({
      schema, system, input, tools: toolsForModel(), toolResults, timeoutMs
    });

    usage.input_tokens += response.usage?.input_tokens || 0;
    usage.output_tokens += response.usage?.output_tokens || 0;
    usage.calls += 1;

    const calls = response.tool_calls || [];
    if (!calls.length) {
      return { output: response.output, trace, usage, iterations, stop_reason: stopReason,
        meta: response.meta };
    }

    if (totalCalls + calls.length > maxCalls) {
      stopReason = 'max_calls_exceeded';
      logger.warn('[tool-runner] max_calls_exceeded', { requested: calls.length, totalCalls, maxCalls });
      break;
    }

    const settled = [];
    for (const call of calls) {
      totalCalls += 1;
      const startedAt = Date.now();
      let result;

      if (!isReadTool(call.name)) {
        // Un ACTION COMMAND pedido por el modelo no es un fallo del modelo: es
        // exactamente lo que este guard existe para atrapar. Se registra.
        result = toolResult(TOOL_STATUS.NOT_AUTHORIZED, {
          reason: 'action_command_not_callable_by_model',
          missing: []
        });
        logger.warn('[tool-runner] action_command_blocked', { tool: call.name });
      } else {
        try {
          result = await executor(call.name, call.arguments || {});
        } catch (error) {
          result = toolResult(TOOL_STATUS.ERROR, {
            reason: String(error?.code || error?.message || 'tool_execution_failed').slice(0, 120)
          });
        }
      }

      trace.push({
        tool: call.name, arguments: call.arguments || {},
        status: result?.status || TOOL_STATUS.ERROR,
        reason: result?.reason || null,
        latency_ms: Date.now() - startedAt
      });
      settled.push({ tool_use_id: call.id, assistantBlock: call._raw, result });
    }

    toolResults = settled;
  }

  if (stopReason === 'completed') stopReason = 'max_iterations_exceeded';
  logger.warn('[tool-runner] loop_stopped', { stop_reason: stopReason, iterations, totalCalls });
  // Se agoto el lazo sin respuesta final. No se inventa una: se devuelve
  // output null y el llamador cae a su camino determinista.
  return { output: null, trace, usage, iterations, stop_reason: stopReason, meta: null };
}

module.exports = { runToolLoop, MAX_ITERATIONS, MAX_CALLS_PER_TURN };
