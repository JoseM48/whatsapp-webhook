'use strict';

// Ejecutor real de read tools -- BLOQUE C, seccion F/G.
//
// Es el unico punto donde una tool pedida por el modelo se convierte en una
// llamada al PMS de produccion. Todo lo que pasa por aqui va por el puente
// HTTP autenticado; no hay ningun otro camino.
//
// TRES GUARDIAS, y ninguna sustituye a las otras:
//
//   1. AQUI. isReadTool() rechaza cualquier nombre que no sea una read tool
//      antes de que salga un solo paquete de red. El lazo de tools ya hace
//      esta comprobacion; se repite porque este modulo puede llamarse desde
//      otro sitio manana y una frontera que depende de que el llamante sea
//      correcto no es una frontera.
//   2. EN EL PUENTE (pms-lite). READ_TOOL_HANDLERS es el despachador: un
//      nombre que no este ahi no existe. Las action commands conocidas
//      responden 403 y quedan registradas.
//   3. EN EL CONTRATO. Las action commands ni siquiera se envian al modelo en
//      la lista de tools, asi que pedirlas ya es un evento anomalo.
//
// EL CONTEXTO NO LO PONE EL MODELO. `context` lo fija el llamante -- caso,
// lead, fecha de referencia -- y el modelo no puede modificarlo desde sus
// argumentos. Es lo que impide que pida la conversacion o la cotizacion de
// otro huesped: los identificadores nunca viajan como argumento de tool.

const { isReadTool, toolResult, TOOL_STATUS } = require('./tools.js');

function createPmsToolExecutor({ pmsClient, context = {}, logger = console }) {
  if (!pmsClient || typeof pmsClient.conversationalTool !== 'function') {
    throw Object.assign(new Error('pms_client_without_conversational_bridge'),
      { code: 'pms_client_without_conversational_bridge' });
  }

  return async function execute(toolName, args = {}) {
    if (!isReadTool(toolName)) {
      logger.warn('[pms-executor] non_read_tool_rejected', { tool: String(toolName).slice(0, 60) });
      return toolResult(TOOL_STATUS.NOT_AUTHORIZED, {
        reason: 'action_command_not_callable_by_model', missing: []
      });
    }

    // El cliente ya degrada a un contrato de error en vez de lanzar: un fallo
    // de red de una consulta no puede tumbar el turno entero.
    return pmsClient.conversationalTool(toolName, args, context);
  };
}

module.exports = { createPmsToolExecutor };
