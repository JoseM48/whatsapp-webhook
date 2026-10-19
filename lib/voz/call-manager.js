'use strict';

// Orquestador de las llamadas de voz (plan A del documento de diseño):
//
//   Cliente WhatsApp --llama--> Meta --SIP--> OpenAI Realtime
//                                              | webhook realtime.call.incoming
//                                              v
//   whatsapp-webhook (este modulo):
//     1. verifica la firma del webhook de OpenAI;
//     2. pide al PMS el contexto y el gasto del mes; aplica el tope;
//     3. acepta la llamada con las instrucciones de Cami voz y las
//        herramientas de lectura (o la rechaza y escribe por WhatsApp);
//     4. abre el WebSocket lateral y ejecuta las herramientas contra el PMS
//        (POST /internal/conversational-tool, solo lectura);
//     5. al colgar: transcripcion en texto + resumen al PMS y un WhatsApp con
//        el resumen y el siguiente paso (la llamada abre la ventana de 24 h).
//
// El audio nunca pasa por aqui ni se guarda. Los logs llevan el telefono
// enmascarado (ultimos 4) y nunca texto de la conversacion.

const { decidirAdmision, costoDeLlamada, costoMaximoPorLlamada } = require('./cost-guard');
const { verifyOpenAiWebhook } = require('./openai-webhook-signature');
const { parseOpenAiCallIncoming } = require('./call-events');
const { herramientasDeVoz, instruccionesCamiVoz, instruccionSaludo, instruccionUltimoMinuto, HERRAMIENTAS_PMS } = require('./cami-voz');

const TEXTO_NO_DISPONIBLE = 'Hola, soy Cami, la asistente virtual de Miu La Frontera. En este momento no puedo atender llamadas, '
  + 'pero te ayudo por aquí mismo: cuéntame las fechas, cuántas personas son y qué necesitas, y te respondo enseguida.';
const TEXTO_SEGUIMIENTO_FIJO = 'Gracias por llamar a Miu La Frontera. Te sigo atendiendo por este chat: escríbeme las fechas y '
  + 'cuántas personas son, y te envío la propuesta por escrito para que la revises.';
const MAX_SALIDA_HERRAMIENTA = 6000;
const MAX_TURNOS = 400;

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

function hoyBogota(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

function createVozCallManager({
  config, http, WebSocketImpl, pms, executePmsTool, sendText, logger = console,
  now = () => Date.now(), timers = { setTimeout, clearTimeout },
}) {
  const activas = new Map();
  const vistas = new Map(); // callId -> ms, para deduplicar reintentos del webhook
  const headers = () => ({ Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' });
  const costoMax = costoMaximoPorLlamada(config);

  function yaVista(callId) {
    const t = now();
    for (const [id, at] of vistas) if (t - at > 6 * 3600 * 1000) vistas.delete(id);
    if (vistas.has(callId)) return true;
    vistas.set(callId, t);
    return false;
  }

  async function openai(path, body) {
    return http.post(`${config.apiBase}${path}`, body ?? {}, { headers: headers(), timeout: 10_000 });
  }

  async function pmsSeguro(nombre, fn) {
    try { return await fn(); } catch (error) {
      logger.error('[voz] pms_fallo', { paso: nombre, code: error?.code || null, http_status: error?.response?.status || null });
      return null;
    }
  }

  async function rechazar(entrada, motivo, { avisarPorTexto = true } = {}) {
    try { await openai(`/realtime/calls/${encodeURIComponent(entrada.callId)}/reject`, { status_code: 486 }); } catch (error) {
      logger.error('[voz] reject_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
    }
    logger.info('[voz] llamada_rechazada', { motivo, phone: mascara(entrada.telefono) });
    await pmsSeguro('estado', () => pms.vozEstado({ call_id: entrada.callId, estado: 'rechazada', motivo }));
    if (avisarPorTexto && entrada.telefono) {
      try { await sendText(entrada.telefono, TEXTO_NO_DISPONIBLE); } catch (error) {
        logger.error('[voz] texto_rechazo_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
    }
  }

  function sesion(ctx) {
    return {
      type: 'realtime',
      model: config.modelo,
      instructions: instruccionesCamiVoz({ hoy: ctx.hoy, nombre: ctx.nombre, huespedAirbnb: ctx.huespedAirbnb,
        personaAlMando: ctx.personaAlMando, duracionMaxMin: config.duracionMaxMin }),
      audio: {
        input: { transcription: { model: config.modeloTranscripcion, language: 'es' } },
        output: { voice: config.voz },
      },
      tools: herramientasDeVoz(),
      tool_choice: 'auto',
    };
  }

  /**
   * Webhook de OpenAI. Devuelve {status, body} de inmediato y procesa la
   * llamada en segundo plano (`procesando`, expuesto para pruebas).
   */
  function handleWebhook({ rawBody, headers: reqHeaders, body }) {
    if (!config.habilitada) return { status: 404, body: { error: 'voz_deshabilitada' } };
    const firma = verifyOpenAiWebhook({ rawBody, headers: reqHeaders, secret: config.webhookSecret, nowMs: now() });
    if (!firma.ok) {
      logger.warn('[voz] webhook_firma_rechazada', { code: firma.error });
      return { status: firma.status, body: { error: firma.error } };
    }
    const entrada = parseOpenAiCallIncoming(body);
    if (!entrada) {
      logger.info('[voz] webhook_ignorado', { type: String(body?.type || '').slice(0, 60) });
      return { status: 200, body: { ok: true } };
    }
    if (yaVista(entrada.callId)) return { status: 200, body: { ok: true, deduplicated: true } };
    const procesando = atender(entrada).catch((error) => {
      logger.error('[voz] atender_fallo', { code: error?.code || error?.message || 'unknown' });
    });
    return { status: 200, body: { ok: true }, procesando };
  }

  async function atender(entrada) {
    logger.info('[voz] llamada_entrante', { phone: mascara(entrada.telefono), wacid_present: Boolean(entrada.wacid) });
    if (!config.apiKey) {
      logger.error('[voz] sin_api_key');
      return;
    }
    const inicio = await pmsSeguro('inicio', () => pms.vozInicio({
      call_id: entrada.callId, telefono: entrada.telefono, wacid: entrada.wacid, modelo: config.modelo,
      costo_max_llamada_usd: costoMax, duracion_max_min: config.duracionMaxMin,
    }));
    // Sin el PMS no se puede saber el gasto del mes: no se acepta (el tope manda).
    if (!inicio) return rechazar(entrada, 'pms_no_disponible');
    const decision = decidirAdmision({ usoMesUsd: inicio.uso_mes_usd, enCurso: activas.size, topeUsdMes: config.topeUsdMes,
      duracionMaxMin: config.duracionMaxMin, costoUsdMinuto: config.costoUsdMinuto });
    if (!decision.admitir) {
      logger.warn('[voz] tope', { motivo: decision.motivo, uso_mes_usd: inicio.uso_mes_usd, en_curso: activas.size });
      return rechazar(entrada, decision.motivo);
    }

    const ctx = {
      ...entrada, hoy: hoyBogota(new Date(now())), nombre: inicio.nombre_saludo || null,
      huespedAirbnb: inicio.huesped_airbnb === true, personaAlMando: inicio.persona_al_mando === true,
      leadId: inicio.lead_id ?? null, transcripcion: [], herramientas: [], requierePersona: false,
      aceptadaAt: null, cerrada: false, ws: null, timers: [],
    };
    activas.set(entrada.callId, ctx); // reserva el cupo antes de aceptar
    try {
      await openai(`/realtime/calls/${encodeURIComponent(entrada.callId)}/accept`, sesion(ctx));
    } catch (error) {
      activas.delete(entrada.callId);
      logger.error('[voz] accept_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      await pmsSeguro('estado', () => pms.vozEstado({ call_id: entrada.callId, estado: 'fallida', motivo: 'accept_fallo' }));
      return;
    }
    ctx.aceptadaAt = now();
    logger.info('[voz] llamada_aceptada', { phone: mascara(entrada.telefono), modelo: config.modelo,
      lead: ctx.leadId != null, airbnb: ctx.huespedAirbnb });
    await pmsSeguro('estado', () => pms.vozEstado({ call_id: entrada.callId, estado: 'aceptada' }));
    programarLimites(ctx);
    conectar(ctx);
  }

  function programarLimites(ctx) {
    const maxMs = config.duracionMaxMin * 60_000;
    if (maxMs > 90_000) {
      ctx.timers.push(timers.setTimeout(() => enviar(ctx, { type: 'response.create', response: { instructions: instruccionUltimoMinuto() } }),
        maxMs - 60_000));
    }
    ctx.timers.push(timers.setTimeout(() => colgar(ctx, 'duracion_maxima'), maxMs));
  }

  function enviar(ctx, evento) {
    try {
      if (ctx.ws && ctx.ws.readyState === 1) ctx.ws.send(JSON.stringify(evento));
    } catch (error) {
      logger.error('[voz] ws_envio_fallo', { code: error?.code || null });
    }
  }

  async function colgar(ctx, motivo, { tras_cierre: trasCierre = false } = {}) {
    if (ctx.cerrada || ctx.colgando) return;
    ctx.colgando = true;
    ctx.motivoCierre = ctx.motivoCierre || motivo;
    try { await openai(`/realtime/calls/${encodeURIComponent(ctx.callId)}/hangup`); } catch (error) {
      // Tras cierre del WebSocket lo normal es que la llamada ya haya terminado.
      const nivel = trasCierre ? 'info' : 'error';
      logger[nivel]('[voz] hangup_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
    }
    if (ctx.ws && ctx.ws.readyState !== 3) {
      try { ctx.ws.close(); } catch { /* ya cerrado */ }
      return; // el evento 'close' finaliza
    }
    await finalizar(ctx);
  }

  function conectar(ctx) {
    let ws;
    try {
      ws = new WebSocketImpl(`${config.wsBase}/realtime?call_id=${encodeURIComponent(ctx.callId)}`,
        { headers: { Authorization: `Bearer ${config.apiKey}` } });
    } catch (error) {
      logger.error('[voz] ws_no_abre', { code: error?.code || null });
      colgar(ctx, 'ws_no_abre');
      return;
    }
    ctx.ws = ws;
    ws.on('open', () => enviar(ctx, { type: 'response.create', response: { instructions: instruccionSaludo() } }));
    ws.on('message', (data) => {
      let evento;
      try { evento = JSON.parse(String(data)); } catch { return; }
      manejarEvento(ctx, evento).catch((error) => logger.error('[voz] evento_fallo', { code: error?.code || error?.message || null }));
    });
    ws.on('error', (error) => logger.error('[voz] ws_error', { code: error?.code || null }));
    // El WebSocket lateral se cierra cuando termina la llamada. Si se cerro por
    // otra causa, se cuelga para no dejar una llamada sin herramientas.
    ws.on('close', () => {
      const cierre = ctx.colgando ? finalizar(ctx) : colgar(ctx, 'fin_llamada', { tras_cierre: true });
      cierre.catch((error) => logger.error('[voz] finalizar_fallo', { code: error?.code || error?.message || null }));
    });
  }

  function anotar(ctx, quien, texto) {
    const t = String(texto || '').trim();
    if (!t || ctx.transcripcion.length >= MAX_TURNOS) return;
    ctx.transcripcion.push({ quien, texto: t.slice(0, 2000), en: new Date(now()).toISOString() });
  }

  async function manejarEvento(ctx, evento) {
    switch (evento?.type) {
      case 'conversation.item.input_audio_transcription.completed':
        anotar(ctx, 'huesped', evento.transcript);
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        anotar(ctx, 'cami', evento.transcript);
        return;
      case 'response.done':
        return ejecutarHerramientas(ctx, evento.response?.output || []);
      case 'error':
        logger.error('[voz] openai_error', { code: String(evento.error?.code || evento.error?.type || '').slice(0, 80) });
        return;
      default:
    }
  }

  async function ejecutarHerramientas(ctx, salida) {
    const llamadas = salida.filter((item) => item?.type === 'function_call' && item.call_id && item.name);
    if (!llamadas.length) return;
    let colgarDespues = false;
    for (const item of llamadas) {
      let args = {};
      try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = {}; }
      let resultado;
      if (item.name === 'terminar_llamada') {
        colgarDespues = true;
        resultado = { status: 'ok' };
      } else if (item.name === 'pedir_persona') {
        ctx.requierePersona = true;
        resultado = { status: 'ok', data: { registrado: true } };
      } else if (HERRAMIENTAS_PMS.has(item.name)) {
        resultado = await executePmsTool(item.name, args, { as_of: ctx.hoy, proposal_snapshot: null });
      } else {
        resultado = { status: 'not_authorized', reason: 'herramienta_no_disponible' };
      }
      ctx.herramientas.push(item.name);
      logger.info('[voz] herramienta', { tool: item.name, status: resultado?.status || null });
      let salidaTexto = JSON.stringify(resultado ?? null);
      if (salidaTexto.length > MAX_SALIDA_HERRAMIENTA) salidaTexto = salidaTexto.slice(0, MAX_SALIDA_HERRAMIENTA);
      enviar(ctx, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: salidaTexto } });
    }
    if (colgarDespues) {
      // Deja terminar la despedida antes de colgar.
      ctx.timers.push(timers.setTimeout(() => colgar(ctx, 'despedida'), 4000));
      return;
    }
    enviar(ctx, { type: 'response.create' });
  }

  async function resumir(ctx) {
    const huesped = ctx.transcripcion.filter((t) => t.quien === 'huesped');
    if (!huesped.length) return { resumen: null, mensaje: TEXTO_SEGUIMIENTO_FIJO };
    const conversacion = ctx.transcripcion.map((t) => `${t.quien === 'cami' ? 'Cami' : 'Cliente'}: ${t.texto}`).join('\n').slice(-12000);
    const sistema = [
      'Resumes una llamada de WhatsApp entre Cami (asistente virtual con IA de Miu La Frontera, apartamentos amoblados en Medellín) y un cliente.',
      'Devuelve SOLO un JSON: {"resumen": string, "mensaje": string}.',
      '"resumen": 1 a 3 frases para el equipo: qué busca (fechas, noches, personas, apartamento), qué se respondió y qué quedó pendiente.',
      '"mensaje": WhatsApp para el cliente, en español colombiano cálido, máximo 600 caracteres, sin emojis. Empieza con "Gracias por llamar a Miu La Frontera." Resume lo que se habló y termina con el siguiente paso concreto.',
      'NO incluyas precios ni montos en el mensaje (el valor exacto va en la propuesta escrita). No prometas nada que Cami no haya dicho. No inventes datos.',
      ctx.huespedAirbnb
        ? 'El cliente es huésped de una reserva de Airbnb: NO le ofrezcas reservar directo ni enviarle propuesta; el siguiente paso es que escriba por aquí si necesita algo de su estadía.'
        : 'Si el cliente quiere cotizar o reservar, el siguiente paso es: "Respóndeme por aquí y te envío la propuesta por escrito para que la confirmes".',
      ctx.requierePersona ? 'El cliente pidió hablar con una persona: di que José Manuel o el equipo le escribe por este chat.' : '',
    ].filter(Boolean).join('\n');
    try {
      const r = await http.post(`${config.apiBase}/chat/completions`, {
        model: config.modeloResumen,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: conversacion }],
        max_tokens: 500,
      }, { headers: headers(), timeout: 20_000 });
      const json = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
      const mensaje = String(json.mensaje || '').trim().slice(0, 1000);
      return { resumen: String(json.resumen || '').trim().slice(0, 2000) || null, mensaje: mensaje || TEXTO_SEGUIMIENTO_FIJO };
    } catch (error) {
      logger.error('[voz] resumen_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      return { resumen: null, mensaje: TEXTO_SEGUIMIENTO_FIJO };
    }
  }

  async function finalizar(ctx) {
    if (ctx.cerrada) return;
    ctx.cerrada = true;
    for (const t of ctx.timers) timers.clearTimeout(t);
    activas.delete(ctx.callId);
    const segundos = ctx.aceptadaAt ? Math.max(0, Math.round((now() - ctx.aceptadaAt) / 1000)) : 0;
    const costo = costoDeLlamada(segundos, config.costoUsdMinuto);
    const { resumen, mensaje } = await resumir(ctx);
    // Con una persona del equipo al mando no se escribe en automatico.
    let enviado = false;
    if (ctx.telefono && !ctx.personaAlMando) {
      try { await sendText(ctx.telefono, mensaje); enviado = true; } catch (error) {
        logger.error('[voz] seguimiento_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
    }
    await pmsSeguro('fin', () => pms.vozFin({
      call_id: ctx.callId, estado: 'terminada', motivo: ctx.motivoCierre || null, duracion_segundos: segundos,
      costo_estimado_usd: costo, transcripcion: ctx.transcripcion, resumen, seguimiento_texto: mensaje,
      seguimiento_enviado: enviado, requiere_persona: ctx.requierePersona, herramientas_usadas: ctx.herramientas.slice(0, 100),
    }));
    logger.info('[voz] llamada_terminada', { phone: mascara(ctx.telefono), segundos, costo_usd: costo,
      turnos: ctx.transcripcion.length, herramientas: ctx.herramientas.length, seguimiento: enviado,
      requiere_persona: ctx.requierePersona, motivo: ctx.motivoCierre || 'colgo' });
  }

  /** Eventos del campo `calls` de Meta: solo se registran (sin contestar). */
  async function registrarEventosMeta(eventos) {
    for (const ev of eventos) {
      logger.info('[voz] meta_call_event', { evento: ev.evento, estado: ev.estado, direccion: ev.direccion, phone: mascara(ev.telefono) });
      if (!config.habilitada) continue;
      await pmsSeguro('meta_evento', () => pms.vozMetaEvento({ wacid: ev.wacid, evento: ev.evento, estado: ev.estado,
        telefono: ev.telefono, duracion_segundos: ev.duracionSegundos, ocurrido_at: ev.ocurridoAt }));
    }
  }

  return { handleWebhook, registrarEventosMeta, activas, _interno: { atender, finalizar, manejarEvento, resumir } };
}

module.exports = { createVozCallManager, TEXTO_NO_DISPONIBLE, TEXTO_SEGUIMIENTO_FIJO, mascara, hoyBogota };
