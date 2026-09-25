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

// Experimento (2026-09-24): 4 rondas se agotaban en "¿el 210 tiene balcon?"
// (referencia -> atributos -> conocimiento -> politica) y el turno caia a
// legacy. Seis rondas siguen acotadas por MAX_CALLS_PER_TURN.
const MAX_ITERATIONS = 6;
const MAX_CALLS_PER_TURN = 8;  // techo absoluto, independiente de las rondas

async function runToolLoop({ provider, schema, system, input, executor, traceRef,
  maxIterations = MAX_ITERATIONS, maxCalls = MAX_CALLS_PER_TURN, timeoutMs, logger = console }) {

  const trace = traceRef ? traceRef.trace : [];
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let toolResults = null;
  let iterations = 0;
  let totalCalls = 0;
  let stopReason = 'completed';

  // Memoria de llamadas del turno: clave = tool + argumentos exactos.
  //
  // POR QUE EXISTE. Sondeando produccion el 2026-09-22, ante "¿el 210 tiene
  // balcon?" el modelo pedia resolve_apartment_reference y
  // get_public_apartment_attributes, recibia needs_clarification en la segunda
  // -- el apartamento no tiene content_unit publicada -- y volvia a pedir
  // EXACTAMENTE las dos mismas llamadas, vuelta tras vuelta, hasta agotar el
  // lazo. Cuatro llamadas identicas, cero informacion nueva, y el turno
  // terminaba en fallback.
  //
  // Repetir una consulta con los mismos argumentos no puede dar una respuesta
  // distinta: la tool es side-effect free. Asi que se sirve la respuesta ya
  // obtenida, marcada, y si una vuelta entera no aporta ninguna llamada nueva
  // se corta. Es una garantia del lazo, no una esperanza puesta en el prompt.
  const alreadyCalled = new Map();
  let noProgressStreak = 0;
  const callKey = (call) => `${call.name}:${JSON.stringify(call.arguments || {})}`;
  // Experimento (2026-09-24, bateria caso H): devolver la respuesta cacheada
  // "marcada" no siempre destrababa al modelo -- volvia a pedir lo mismo y el
  // turno caia a legacy. Tras una vuelta sin llamadas nuevas, la siguiente
  // peticion lleva ademas la instruccion explicita de emitir ya. Si aun asi
  // repite, la segunda vuelta sin progreso corta como antes.
  const EMIT_NOW = '\n\n[SYSTEM] Every tool you asked for has already answered this turn and repeating a call cannot '
    + 'change its answer. Do not call any tool now: emit the interpretation object with what you have '
    + '(record what could not be resolved in "ambiguity" and the unpublished topics in "knowledge_topics").';

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await provider.structured({
      schema, system, input: noProgressStreak > 0 ? input + EMIT_NOW : input,
      tools: toolsForModel(), toolResults, timeoutMs
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
    let newCallsThisIteration = 0;
    for (const call of calls) {
      totalCalls += 1;
      const startedAt = Date.now();
      let result;

      const key = callKey(call);
      if (alreadyCalled.has(key)) {
        const previous = alreadyCalled.get(key);
        result = { ...previous,
          reason: `${previous.reason || previous.status}; repeated_call_same_arguments_no_new_information` };
        trace.push({ tool: call.name, arguments: call.arguments || {},
          status: result.status, reason: 'repeated_call', latency_ms: 0 });
        settled.push({ tool_use_id: call.id, assistantBlock: call._raw, result });
        continue;
      }
      newCallsThisIteration += 1;

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
      alreadyCalled.set(key, result);
    }

    // Una vuelta sin llamadas nuevas NO corta todavia: las respuestas
    // cacheadas se devuelven igual, marcadas, porque leer "ya preguntaste esto
    // y la respuesta fue X" es justo lo que suele destrabar al modelo y
    // hacerle escribir su respuesta final. Cortar aqui seria condenar el turno
    // a fallback teniendo ya la informacion en la mano. Dos vueltas seguidas
    // sin nada nuevo si son un lazo, y entonces se corta.
    noProgressStreak = newCallsThisIteration === 0 ? noProgressStreak + 1 : 0;
    if (noProgressStreak >= 2) {
      stopReason = 'repeated_calls_no_progress';
      logger.warn('[tool-runner] repeated_calls_no_progress', { iterations, totalCalls });
      break;
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
