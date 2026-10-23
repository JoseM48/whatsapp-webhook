'use strict';

// TOPE DE GASTO DE LAS LLAMADAS (VOZ_TOPE_USD_MES, por defecto USD 50).
//
// El costo es una ESTIMACION: minutos x VOZ_COSTO_USD_MINUTO. La factura real
// la pone OpenAI; por eso el proyecto de OpenAI lleva ademas su propio limite
// de presupuesto (configuracion que hace José Manuel).
//
// Regla conservadora: una llamada solo se acepta si, aun durando el maximo
// permitido, el mes no pasa del tope contando tambien las llamadas que estan
// en curso como si fueran a durar el maximo. Asi el tope se cumple aunque
// entren varias llamadas a la vez.

function costoDeLlamada(segundos, costoUsdMinuto) {
  const s = Math.max(0, Number(segundos) || 0);
  return Math.round((s / 60) * Number(costoUsdMinuto || 0) * 10000) / 10000;
}

function costoMaximoPorLlamada({ duracionMaxMin, costoUsdMinuto }) {
  return Math.round(Number(duracionMaxMin) * Number(costoUsdMinuto) * 10000) / 10000;
}

// enCursoUsd (2026-10-23): suma del maximo de cada llamada en curso; las de
// aliados pueden durar mas que las de ventas. Sin el, enCurso x maximo propio.
function decidirAdmision({ usoMesUsd, enCurso = 0, enCursoUsd = null, topeUsdMes, duracionMaxMin, costoUsdMinuto }) {
  const uso = Number(usoMesUsd);
  if (!Number.isFinite(uso) || uso < 0) return { admitir: false, motivo: 'uso_desconocido' };
  const porLlamada = costoMaximoPorLlamada({ duracionMaxMin, costoUsdMinuto });
  const curso = Number.isFinite(Number(enCursoUsd)) && enCursoUsd !== null ? Math.max(0, Number(enCursoUsd))
    : Math.max(0, Number(enCurso) || 0) * porLlamada;
  const comprometido = uso + curso + porLlamada;
  if (comprometido > Number(topeUsdMes)) {
    return { admitir: false, motivo: 'tope_mensual', uso_mes_usd: uso, comprometido_usd: comprometido };
  }
  return { admitir: true, motivo: null, uso_mes_usd: uso, comprometido_usd: comprometido };
}

module.exports = { costoDeLlamada, costoMaximoPorLlamada, decidirAdmision };
