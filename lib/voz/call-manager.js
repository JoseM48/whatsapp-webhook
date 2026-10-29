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
const { herramientasDeVoz, instruccionesCamiVoz, instruccionSaludo, instruccionUltimoMinuto, instruccionCincoMinutos, HERRAMIENTAS_PMS,
  NOMBRES_HERRAMIENTAS, normalizarArgsVoz, codigoApartamento, salidaDesde, comoDecirlo, avisoImagenEnChat, aliadoDesdeInicio } = require('./cami-voz');
const { photoForKey } = require('../pilot/apartment-photos');

// Revision 2026-10-19 (P1-2, P2-5): los textos al huesped son FIJOS y viven en
// el PMS (voz-llamadas.service.js), que los encola por la cola de siempre
// (control humano, CEM). El webhook solo elige el paso y, si el PMS responde
// 'sin_caso' (quien llama nunca escribio), envia ese mismo texto fijo directo.
const PASOS = ['cotizacion', 'persona', 'estadia', 'escribenos'];
const ALERTAS = ['persona', 'queja', 'emergencia'];
// USO ACEPTABLE (2026-10-24): si el PMS no responde, Cami igual NO ejecuta el
// pedido y dice esto (los textos aprobados viven en uso_aceptable_v1).
const USO_ACEPTABLE_RESPALDO = Object.freeze({
  prohibido: 'Con eso no te puedo ayudar, porque va en contra de nuestra política de uso aceptable. Si necesitas otra cosa, con mucho gusto te ayudo.',
  restringido: 'Eso lo tengo que consultar primero con el equipo, porque necesita una revisión o un permiso especial. Te confirmamos por el chat de WhatsApp.',
});
const MAX_SALIDA_HERRAMIENTA = 6000;
const MAX_TURNOS = 400;
// ALIADOS (2026-10-23): la entrevista puede durar mas que una llamada de ventas
// (la politica voz_aliados_v1 del PMS manda), con este techo duro de 50 min
// (coordinacion, 2026-10-23): la doc oficial de OpenAI da hasta 60 min por
// sesion Realtime y corta sin avisar; 10 min de margen.
const DURACION_MAX_ALIADO_TECHO_MIN = 50;
// Aviso de cierre de la entrevista: a 3 min del final (minuto 37 de 40).
const AVISO_CIERRE_ALIADO_MS = 3 * 60_000;
// Una entrevista larga tiene muchos turnos (revision 2026-10-23, P2-2): el PMS
// acepta hasta 1000 (migracion 907); las de ventas siguen en 400.
const MAX_TURNOS_ALIADO = 1000;

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

function hoyBogota(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

function createVozCallManager({
  config, http, WebSocketImpl, pms, executePmsTool, sendText, sendImage = null, entregarAhora = null, logger = console,
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

  async function rechazar(entrada, motivo) {
    try { await openai(`/realtime/calls/${encodeURIComponent(entrada.callId)}/reject`, { status_code: 486 }); } catch (error) {
      logger.error('[voz] reject_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
    }
    logger.info('[voz] llamada_rechazada', { motivo, phone: mascara(entrada.telefono) });
    // El PMS encola el aviso fijo (y lo suprime si una persona tiene la
    // conversacion). Si el PMS no responde no se escribe nada: no se puede
    // saber si hay una persona al mando.
    const r = await pmsSeguro('estado', () => pms.vozEstado({ call_id: entrada.callId, estado: 'rechazada', motivo,
      avisar_huesped: true }));
    await enviarDirectoSiSinCaso(entrada, r);
  }

  // SALIDA Y LATE CHECK-OUT (2026-10-26): el PMS crea el cobro (misma función
  // que el chat) y lo encola al chat; sin conversación, el texto vuelve y se
  // envía directo, como el seguimiento.
  async function solicitarLateCheckout(ctx, args, tipo = 'late') {
    const crudo = String((tipo === 'early' ? args?.hora : args?.hasta) || '').trim();
    const hora = /^\d{1,2}:\d{2}$/.test(crudo) ? crudo : null;
    const palabra = tipo === 'early' ? 'EARLY' : 'LATE';
    const r = await pmsSeguro('late_checkout', () => pms.vozLateCheckout({ call_id: ctx.callId, ...(tipo === 'early' ? { tipo, ...(hora ? { hora } : {}) } : (hora ? { hasta: hora } : {})) }));
    if (!r) {
      return { status: 'error', reason: 'no_se_pudo_registrar',
        instruccion_modelo: `No pude pedirlo ahora: dile que escriba ${palabra} por el chat de WhatsApp y ahí se lo confirman. No des datos de pago por teléfono.` };
    }
    let enviadoDirecto = false;
    if (r.seguimiento_via === 'sin_caso' && r.seguimiento_texto && ctx.telefono) {
      try { await sendText(ctx.telefono, r.seguimiento_texto); enviadoDirecto = true; } catch (error) {
        logger.error('[voz] late_checkout_texto_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
    }
    const instruccion = r.seguimiento_via === 'sin_caso' && !enviadoDirecto
      ? `No pude escribirle al chat: dile que escriba ${palabra} por el chat de WhatsApp. No des datos de pago por teléfono.`
      : (r.instruccion_modelo || null);
    return { status: r.solicitado || r.estado === 'falta_hora' ? 'ok' : 'not_authorized', data: { estado: r.estado || r.motivo || null,
      enviado_al_chat: r.enviado_al_chat === true || enviadoDirecto }, instruccion_modelo: instruccion };
  }

  // Quien llama no tiene conversacion en el PMS: el mismo texto fijo, directo.
  async function enviarDirectoSiSinCaso(entrada, r) {
    if (r?.seguimiento_via !== 'sin_caso' || !r.seguimiento_texto || !entrada.telefono) return false;
    let enviado = false;
    try { await sendText(entrada.telefono, r.seguimiento_texto); enviado = true; } catch (error) {
      logger.error('[voz] texto_directo_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
    }
    await pmsSeguro('seguimiento_directo', () => pms.vozSeguimientoDirecto({ call_id: entrada.callId, enviado }));
    return enviado;
  }

  function sesion(ctx) {
    return {
      type: 'realtime',
      model: config.modelo,
      instructions: instruccionesCamiVoz({ hoy: ctx.hoy, nombre: ctx.nombre, huespedAirbnb: ctx.huespedAirbnb,
        personaAlMando: ctx.personaAlMando, propietariaOnboarding: ctx.propietariaOnboarding, paqueteMagia: ctx.paqueteMagia, duracionMaxMin: ctx.duracionMaxMin,
        inventario: ctx.inventario, aliado: ctx.aliado, clienteReconocido: ctx.sinComerciales ? null : ctx.clienteReconocido,
        direccionEstadia: ctx.aliado ? null : ctx.direccionEstadia, salida: ctx.salida, lateCheckout: !ctx.sinEstadia }),
      audio: {
        input: { transcription: { model: config.modeloTranscripcion, language: 'es' } },
        output: { voice: config.voz },
      },
      tools: herramientasDeVoz({ sinComerciales: ctx.sinComerciales, aliado: Boolean(ctx.aliado), paqueteMagia: ctx.paqueteMagia, sinEstadia: ctx.sinEstadia,
        salida: ctx.salida }),
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
    // SEGUNDO NÚMERO (2026-10-28): una llamada al número de TenGo Camello no
    // llega a Cami de Miu (sin PMS, sin herramientas de cotización y sin el
    // WhatsApp de aviso, que saldría desde el número de Miu): solo se rechaza.
    if (entrada.destino && (config.destinosAjenos || []).includes(entrada.destino)) {
      logger.warn('[voz] llamada_a_numero_ajeno_rechazada', { destino: mascara(entrada.destino), phone: mascara(entrada.telefono) });
      try { await openai(`/realtime/calls/${encodeURIComponent(entrada.callId)}/reject`, { status_code: 486 }); } catch (error) {
        logger.error('[voz] reject_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
      return;
    }
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
    // Perfil de ALIADO (2026-10-23): entrevista de descubrimiento, sin cotizar,
    // con su propia duracion maxima (acotada); el tope mensual sigue mandando.
    const aliado = aliadoDesdeInicio(inicio.aliado_voz);
    const duracionMaxMin = aliado?.duracionMaxMin
      ? Math.min(DURACION_MAX_ALIADO_TECHO_MIN, Math.max(config.duracionMaxMin, aliado.duracionMaxMin)) : config.duracionMaxMin;
    const enCursoUsd = [...activas.values()].reduce((s, c) => s + (Number(c.costoMax) || costoMax), 0);
    const decision = decidirAdmision({ usoMesUsd: inicio.uso_mes_usd, enCurso: activas.size, enCursoUsd, topeUsdMes: config.topeUsdMes,
      duracionMaxMin, costoUsdMinuto: config.costoUsdMinuto });
    if (!decision.admitir) {
      logger.warn('[voz] tope', { motivo: decision.motivo, uso_mes_usd: inicio.uso_mes_usd, en_curso: activas.size });
      return rechazar(entrada, decision.motivo);
    }

    const ctx = {
      ...entrada, hoy: hoyBogota(new Date(now())),
      nombre: aliado?.nombre || inicio.nombre_saludo || inicio.propietaria_onboarding?.nombre_saludo || null,
      aliado, duracionMaxMin, costoMax: costoMaximoPorLlamada({ duracionMaxMin, costoUsdMinuto: config.costoUsdMinuto }),
      // Onboarding de propietarias (2026-10-23): sin cotizar ni ofrecer, sin seguimiento automatico.
      // Un aliado no es huesped ni venta: su perfil manda (el PMS ya resolvio la precedencia).
      propietariaOnboarding: !aliado && inicio.propietaria_onboarding?.no_cotizar === true,
      // Demo del Paquete Magia (2026-10-24): dueño de un negocio de ejemplo; sin cotizar ni seguimiento automático.
      paqueteMagia: !aliado && inicio.paquete_magia?.no_cotizar === true,
      huespedAirbnb: !aliado && inicio.huesped_airbnb === true, personaAlMando: !aliado && inicio.persona_al_mando === true,
      // Corporativo o frecuente (2026-10-27): bienvenida de regreso y tarifas normales.
      clienteReconocido: !aliado && inicio.cliente_reconocido && typeof inicio.cliente_reconocido === 'object' ? inicio.cliente_reconocido : null,
      // Dirección exacta para huésped con reserva confirmada (2026-10-28): la manda el PMS.
      direccionEstadia: !aliado && inicio.direccion_estadia && typeof inicio.direccion_estadia === 'object' ? inicio.direccion_estadia : null,
      leadId: inicio.lead_id ?? null, transcripcion: [], herramientas: [], requierePersona: false, alerta: null,
      inventario: inicio.inventario ?? null, disponibilidad: null, fotosEnviadas: [],
      // SALIDA Y LATE CHECK-OUT (2026-10-26): regla del PMS (null si está apagada).
      salida: inicio.salida ?? null,
      aceptadaAt: null, cerrada: false, ws: null, timers: [],
    };
    ctx.sinComerciales = Boolean(ctx.aliado) || ctx.huespedAirbnb || ctx.personaAlMando || ctx.propietariaOnboarding || ctx.paqueteMagia;
    // Late check-out: solo quien tiene estadía, sin persona al mando ni onboarding.
    ctx.sinEstadia = inicio.tiene_estadia !== true || ctx.propietariaOnboarding || ctx.personaAlMando;
    ctx.permitidas = new Set(herramientasDeVoz({ sinComerciales: ctx.sinComerciales, aliado: Boolean(ctx.aliado), paqueteMagia: ctx.paqueteMagia,
      sinEstadia: ctx.sinEstadia, salida: ctx.salida }).map((h) => h.name));
    activas.set(entrada.callId, ctx); // reserva el cupo antes de aceptar
    // Revision 2026-10-19 (P2-2): se marca 'aceptada' ANTES de aceptar en
    // OpenAI, para que el gasto del mes la cuente aunque se pierda el resto.
    await pmsSeguro('estado', () => pms.vozEstado({ call_id: entrada.callId, estado: 'aceptada' }));
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
      lead: ctx.leadId != null, airbnb: ctx.huespedAirbnb, persona_al_mando: ctx.personaAlMando, propietaria: ctx.propietariaOnboarding, paquete_magia: ctx.paqueteMagia,
      aliado: Boolean(ctx.aliado), duracion_max_min: ctx.duracionMaxMin });
    programarLimites(ctx);
    conectar(ctx);
  }

  function programarLimites(ctx) {
    const maxMs = (ctx.duracionMaxMin || config.duracionMaxMin) * 60_000;
    if (ctx.aliado && maxMs > 10 * 60_000) {
      ctx.timers.push(timers.setTimeout(() => enviar(ctx, { type: 'response.create', response: { instructions: instruccionCincoMinutos() } }),
        maxMs - AVISO_CIERRE_ALIADO_MS));
    }
    if (maxMs > 90_000) {
      ctx.timers.push(timers.setTimeout(() => enviar(ctx, { type: 'response.create', response: { instructions: instruccionUltimoMinuto(ctx.aliado) } }),
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
    // A (2026-10-19): el saludo se generaba apenas abria el WebSocket y el
    // huesped lo oia cortado (o nada, llamada 2): el audio SIP aun no fluia.
    // Se espera VOZ_SALUDO_DEMORA_MS (por defecto 1500 ms); si la persona habla
    // antes, no se fuerza el saludo (Cami se presenta en su primera respuesta).
    // Respaldo (2026-10-22, llamada real 15:43 UTC): un "¿aló?" o ruido de la
    // linea cancelaba el saludo para siempre; si ese audio no terminaba en un
    // turno transcrito, Cami quedaba ~13 s en silencio. Ver programarRespaldo.
    ws.on('open', () => {
      hito(ctx, 'ws_open');
      ctx.saludoPendiente = true;
      ctx.timers.push(timers.setTimeout(() => {
        if (!ctx.saludoPendiente || ctx.cerrada || ctx.colgando) return;
        ctx.saludoPendiente = false;
        saludar(ctx, 'saludo_enviado');
      }, config.saludoDemoraMs));
      hito(ctx, 'saludo_programado', { demora_ms: config.saludoDemoraMs });
    });
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

  // Tiempos por llamada (2026-10-22): solo hitos y milisegundos, nunca audio
  // ni texto. Cada hito se registra una vez (el primero).
  function hito(ctx, nombre, extra = {}) {
    if (!ctx.tiempos) ctx.tiempos = {};
    if (ctx.tiempos[nombre] != null) return;
    const t = now();
    ctx.tiempos[nombre] = ctx.aceptadaAt ? t - ctx.aceptadaAt : 0;
    const desdeOpen = ctx.wsOpenAt != null ? t - ctx.wsOpenAt : null;
    if (nombre === 'ws_open') ctx.wsOpenAt = t;
    logger.info('[voz] tiempo', { phone: mascara(ctx.telefono), hito: nombre, ms_desde_aceptada: ctx.tiempos[nombre],
      ms_desde_ws_open: nombre === 'ws_open' ? 0 : desdeOpen, ...extra });
  }

  function saludar(ctx, nombreHito, extra) {
    ctx.saludoHecho = true;
    hito(ctx, nombreHito, extra);
    enviar(ctx, { type: 'response.create', response: { instructions: instruccionSaludo(ctx.aliado, ctx.sinComerciales ? null : ctx.clienteReconocido) } });
  }

  // Si el saludo se cancelo porque "hablo" alguien (un "¿aló?" o ruido), se
  // revisa a los VOZ_SALUDO_RESPALDO_MS: si no hubo respuesta de Cami ni
  // transcripcion del huesped, se saluda igual. Mientras la persona sigue
  // hablando, o si acaba de callar (la respuesta automatica puede estar en
  // camino), se espera un poco mas, con un tope de 2 x respaldo.
  // Un response.created NO prueba que Cami sono: el server VAD puede cancelar
  // esa respuesta antes del audio (revision 2026-10-22, P1). Solo cuenta audio
  // o transcripcion de Cami, o una respuesta terminada sin cancelar; mientras
  // una respuesta esta en curso, se espera.
  const SILENCIO_TRAS_VOZ_MS = 1000;
  function programarRespaldo(ctx) {
    if (ctx.respaldoProgramado || ctx.cerrada || ctx.colgando) return;
    ctx.respaldoProgramado = true;
    ctx.respaldoLimiteAt = now() + 2 * config.saludoRespaldoMs;
    ctx.timers.push(timers.setTimeout(() => revisarRespaldo(ctx), config.saludoRespaldoMs));
  }

  function revisarRespaldo(ctx) {
    if (ctx.cerrada || ctx.colgando || ctx.saludoHecho) return;
    if (ctx.camiHablo || ctx.huespedTranscrito) {
      hito(ctx, 'saludo_respaldo_innecesario', { motivo: ctx.camiHablo ? 'cami_hablo' : 'huesped_transcrito' });
      return;
    }
    const t = now();
    const vencido = t >= ctx.respaldoLimiteAt;
    if (vencido && ctx.respuestaEnCurso) {
      // Un response.create ahora chocaria con la respuesta activa.
      hito(ctx, 'saludo_respaldo_omitido', { motivo: 'respuesta_en_curso' });
      return;
    }
    if (!vencido) {
      let espera = 0;
      if (ctx.hablando || ctx.respuestaEnCurso) espera = SILENCIO_TRAS_VOZ_MS;
      else if (ctx.vozFinAt != null && t - ctx.vozFinAt < SILENCIO_TRAS_VOZ_MS) espera = SILENCIO_TRAS_VOZ_MS - (t - ctx.vozFinAt);
      if (espera > 0) {
        ctx.timers.push(timers.setTimeout(() => revisarRespaldo(ctx), Math.min(espera, ctx.respaldoLimiteAt - t)));
        return;
      }
    }
    saludar(ctx, 'saludo_forzado', { tope: vencido });
  }

  function anotar(ctx, quien, texto) {
    const t = String(texto || '').trim();
    if (!t || ctx.transcripcion.length >= (ctx.aliado ? MAX_TURNOS_ALIADO : MAX_TURNOS)) return;
    ctx.transcripcion.push({ quien, texto: t.slice(0, 2000), en: new Date(now()).toISOString() });
  }

  async function manejarEvento(ctx, evento) {
    switch (evento?.type) {
      case 'input_audio_buffer.speech_started':
        ctx.hablando = true;
        hito(ctx, 'primer_habla');
        if (ctx.saludoPendiente) {
          ctx.saludoPendiente = false;
          hito(ctx, 'saludo_cancelado');
          programarRespaldo(ctx);
        }
        return;
      case 'input_audio_buffer.speech_stopped':
        ctx.hablando = false;
        ctx.vozFinAt = now();
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (String(evento.transcript || '').trim()) {
          ctx.huespedTranscrito = true;
          hito(ctx, 'primera_transcripcion');
        }
        anotar(ctx, 'huesped', evento.transcript);
        return;
      case 'response.created':
        ctx.respuestaEnCurso = true;
        hito(ctx, 'primera_respuesta');
        return;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
      case 'output_audio_buffer.started':
        ctx.camiHablo = true;
        hito(ctx, 'primer_audio', { evento: evento.type });
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (String(evento.transcript || '').trim()) ctx.camiHablo = true;
        anotar(ctx, 'cami', evento.transcript);
        return;
      case 'response.done': {
        ctx.respuestaEnCurso = false;
        const estado = evento.response?.status || null;
        if (estado === 'completed') ctx.camiHablo = true;
        else hito(ctx, 'primera_respuesta_no_completada', { estado: estado ? String(estado).slice(0, 20) : null });
        return ejecutarHerramientas(ctx, evento.response?.output || []);
      }
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
        // P1-1: aviso inmediato a José Manuel por el mecanismo de avisos internos.
        ctx.requierePersona = true;
        const tipo = ALERTAS.includes(args?.tipo) ? args.tipo : 'persona';
        ctx.alerta = ctx.alerta || tipo;
        ctx.alertaMotivo = ctx.alertaMotivo || String(args?.motivo || '').slice(0, 300) || null;
        const aviso = await pmsSeguro('alerta', () => pms.vozAlerta({ call_id: ctx.callId, tipo,
          motivo: String(args?.motivo || '').slice(0, 300) || null }));
        resultado = { status: 'ok', data: { aviso_enviado: aviso?.aviso_encolado === true || aviso?.duplicado === true } };
      } else if (item.name === 'consultar_al_equipo' && ctx.permitidas.has(item.name)) {
        // CAMI PREGUNTA PRIMERO A TEO (2026-10-24): el PMS decide el ámbito
        // (cliente/aliado/propietaria) y si va a Teo o a José Manuel.
        const pregunta = String(args?.pregunta || '').trim().slice(0, 600);
        if (pregunta.length < 3) {
          resultado = { status: 'needs_clarification', reason: 'falta_pregunta' };
        } else {
          const r = await pmsSeguro('consulta_teo', () => pms.vozConsultaTeo({ call_id: ctx.callId, pregunta,
            contexto: String(args?.contexto || '').trim().slice(0, 600) || null }));
          if (r) {
            resultado = { status: r.registrada ? 'ok' : 'not_authorized', data: { registrada: r.registrada === true, ...(r.motivo ? { motivo: r.motivo } : {}) },
              instruccion_modelo: r.instruccion_modelo || null };
          } else {
            // Revisión independiente (P2-3): si el PMS no la registró (caído, o
            // ruta aún sin desplegar), no se promete nada sin dejar rastro: va
            // como aviso a José Manuel (mismo mecanismo de pedir_persona).
            const aviso = await pmsSeguro('alerta', () => pms.vozAlerta({ call_id: ctx.callId, tipo: 'persona',
              motivo: `Cami no supo responder: ${pregunta}`.slice(0, 300) }));
            const avisado = aviso?.aviso_encolado === true || aviso?.duplicado === true;
            if (avisado) { ctx.requierePersona = true; ctx.alerta = ctx.alerta || 'persona'; }
            resultado = { status: 'error', reason: 'no_se_pudo_registrar', data: { aviso_enviado: avisado },
              instruccion_modelo: avisado
                ? 'Quedó como aviso para José Manuel: dile que se lo confirman por el chat de WhatsApp. No inventes la respuesta.'
                : 'No quedó registrada: pídele con amabilidad que te escriba esa pregunta por el chat de WhatsApp para que el equipo se la responda. No inventes la respuesta.' };
          }
        }
      } else if (item.name === 'ofrecer_paquete_magia' && ctx.permitidas.has(item.name)) {
        // DEMO DEL PAQUETE MAGIA (2026-10-24): el PMS la arranca por el chat (o
        // devuelve qué decirle si la ventana de 24 h está cerrada).
        const r = await pmsSeguro('paquete_magia', () => pms.vozPaqueteMagia({ call_id: ctx.callId }));
        resultado = r
          ? { status: r.iniciada ? 'ok' : 'not_authorized', data: { iniciada: r.iniciada === true, ...(r.motivo ? { motivo: r.motivo } : {}) },
            instruccion_modelo: r.instruccion_modelo || null }
          : { status: 'error', reason: 'no_se_pudo_registrar',
            instruccion_modelo: 'No pude arrancarla ahora: dile que escriba por WhatsApp a este mismo número "Quiero probar el Paquete Magia" y la demo arranca al instante.' };
      } else if (item.name === 'solicitar_late_checkout' && ctx.permitidas.has(item.name)) {
        resultado = await solicitarLateCheckout(ctx, args);
      } else if (item.name === 'solicitar_early_checkin' && ctx.permitidas.has(item.name)) {
        resultado = await solicitarLateCheckout(ctx, args, 'early');
      } else if (item.name === 'evaluar_uso_aceptable') {
        resultado = await evaluarUsoAceptable(ctx, args);
      } else if (item.name === 'enviar_opciones_al_chat' && ctx.permitidas.has(item.name)) {
        resultado = await enviarOpciones(ctx, args);
      } else if (item.name === 'anotar_lista_espera' && ctx.permitidas.has(item.name)) {
        resultado = await anotarListaEspera(ctx, normalizarArgsVoz(item.name, args));
      } else if (item.name === 'quote_stay' && ctx.permitidas.has(item.name) && !disponibilidadCubre(ctx, normalizarArgsVoz(item.name, args))) {
        // B (2026-10-19): por CODIGO, nunca un precio antes de la disponibilidad
        // de esas mismas fechas en esta llamada.
        resultado = { status: 'not_authorized', reason: 'primero_check_availability',
          instruccion: 'Primero consulta check_availability con esas fechas y personas. Da el precio solo si la persona lo pregunta.' };
      } else if (HERRAMIENTAS_PMS.has(item.name) && ctx.permitidas.has(item.name)) {
        // El esquema de la voz se traduce al contrato del PMS (cami-voz.js).
        const pmsArgs = normalizarArgsVoz(item.name, args);
        // LEAD 256 (2026-10-25), paridad con el chat: la direccion exacta depende
        // de la duracion efectiva cotizada. Al PMS van las noches que ESTA llamada
        // consulto o cotizo y el lead (su cotizacion del chat), nunca un dato del modelo.
        const contextoPms = item.name === 'search_commercial_knowledge'
          ? { as_of: ctx.hoy, proposal_snapshot: null, nights: ctx.nochesCotizadas ?? null, lead_id: ctx.leadId ?? null }
          : { as_of: ctx.hoy, proposal_snapshot: null };
        resultado = await executePmsTool(item.name, pmsArgs, contextoPms);
        if ((item.name === 'check_availability' || item.name === 'quote_stay') && resultado?.status === 'ok'
          && Number.isInteger(pmsArgs.nights)) ctx.nochesCotizadas = pmsArgs.nights; // la ULTIMA estadia consultada, como en el chat
        // Fuera del horizonte: se recuerdan las fechas para anotar_lista_espera
        // (si el modelo no repite las personas, se usan las de la consulta).
        if (resultado?.reason === 'outside_direct_quote_horizon' && pmsArgs.arrival_date && pmsArgs.nights) {
          ctx.fueraHorizonte = { arrival_date: pmsArgs.arrival_date, nights: pmsArgs.nights,
            guests: pmsArgs.guests ?? ctx.fueraHorizonte?.guests ?? null };
        }
        if (item.name === 'check_availability' && resultado?.status === 'ok') {
          const disponibles = (resultado.data?.available || []).map((a) => a.apartment_code).filter(Boolean);
          // P2-4: una consulta posterior de UNA unidad con las mismas fechas no
          // achica la lista; con fechas o personas distintas se reemplaza.
          const previa = ctx.disponibilidad;
          const mismas = previa && previa.check_in === pmsArgs.arrival_date && previa.nights === pmsArgs.nights
            && (previa.guests ?? null) === (pmsArgs.guests ?? null);
          ctx.disponibilidad = { codigos: mismas ? [...new Set([...previa.codigos, ...disponibles])] : disponibles,
            check_in: pmsArgs.arrival_date, nights: pmsArgs.nights,
            check_out: salidaDesde(pmsArgs.arrival_date, pmsArgs.nights), guests: pmsArgs.guests ?? null };
        }
      } else {
        resultado = { status: 'not_authorized', reason: 'herramienta_no_disponible' };
      }
      if (NOMBRES_HERRAMIENTAS.has(item.name)) ctx.herramientas.push(item.name);
      logger.info('[voz] herramienta', { tool: item.name, status: resultado?.status || null,
        reason: resultado?.reason ? String(resultado.reason).slice(0, 80) : null,
        missing: Array.isArray(resultado?.missing) ? resultado.missing.slice(0, 5) : null });
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

  // USO ACEPTABLE (2026-10-24): registra el pedido en el PMS (evento auditable y
  // aviso a Teo) y devuelve qué decir. Nunca ejecuta el pedido: la herramienta
  // solo existe para frenarlo.
  async function evaluarUsoAceptable(ctx, args = {}) {
    const decision = args?.decision === 'prohibido' ? 'prohibido' : 'restringido';
    const r = await pmsSeguro('uso_aceptable', () => pms.vozUsoAceptable({ call_id: ctx.callId, decision,
      categoria: typeof args?.categoria === 'string' ? args.categoria.slice(0, 60) : null,
      resumen: typeof args?.resumen === 'string' ? args.resumen.slice(0, 200) : null }));
    const final = r?.decision === 'prohibido' || r?.decision === 'restringido' ? r.decision : decision;
    return { status: 'ok', data: { decision: final, no_ejecutar: true,
      texto_para_decir: r?.texto_para_decir || USO_ACEPTABLE_RESPALDO[final], aviso_enviado: r?.aviso_encolado === true } };
  }

  // Resumen SOLO para el equipo (CEM y ventana de Cami-texto) y deteccion de
  // queja o emergencia. Nada de lo que escribe el modelo se le envia al huesped.
  async function resumir(ctx) {
    const huesped = ctx.transcripcion.filter((t) => t.quien === 'huesped');
    if (!huesped.length) return { resumen: null, alerta: null, alertaMotivo: null };
    if (ctx.aliado) return resumirAliado(ctx);
    const conversacion = ctx.transcripcion.map((t) => `${t.quien === 'cami' ? 'Cami' : 'Cliente'}: ${t.texto}`).join('\n').slice(-12000);
    const sistema = [
      'Resumes para el equipo una llamada de WhatsApp entre Cami (asistente virtual con IA de Miu La Frontera, apartamentos amoblados en Medellín) y un cliente.',
      'Devuelve SOLO un JSON: {"resumen": string, "alerta": "persona" | "queja" | "emergencia" | null, "alerta_motivo": string | null}.',
      '"resumen": 1 a 3 frases: qué busca (fechas, noches, personas, apartamento), qué se respondió y qué quedó pendiente. No inventes datos.',
      '"alerta": "emergencia" si reporta un riesgo o daño urgente (agua, gas, electricidad, seguridad, salud); "queja" si se queja de algo; "persona" si pidió hablar con alguien; si no, null.',
      '"alerta_motivo": una frase corta con el motivo de la alerta, o null.',
    ].join('\n');
    try {
      const r = await http.post(`${config.apiBase}/chat/completions`, {
        model: config.modeloResumen,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: conversacion }],
        max_tokens: 400,
      }, { headers: headers(), timeout: 20_000 });
      const json = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
      return {
        resumen: String(json.resumen || '').trim().slice(0, 2000) || null,
        alerta: ALERTAS.includes(json.alerta) ? json.alerta : null,
        alertaMotivo: json.alerta_motivo ? String(json.alerta_motivo).trim().slice(0, 300) : null,
      };
    } catch (error) {
      logger.error('[voz] resumen_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      return { resumen: null, alerta: null, alertaMotivo: null };
    }
  }

  // ENTREVISTA DE ALIADO (2026-10-23): resumen estructurado por SECCION de la
  // guia, para José Manuel y Desarrollos. Solo con lo dicho; el PMS lo sanea.
  async function resumirAliado(ctx) {
    const g = ctx.aliado.guia;
    const conversacion = ctx.transcripcion.map((t) => `${t.quien === 'cami' ? 'Cami' : 'Aliado'}: ${t.texto}`).join('\n').slice(-60000);
    const secciones = g.secciones.map((s) => `- ${s.clave}: ${s.titulo}. Preguntas: ${s.preguntas.join(' | ')}`).join('\n');
    const sistema = [
      'Resumes para José Manuel (dueño de Miu La Frontera) una entrevista de descubrimiento por llamada entre Cami (asistente virtual con IA de Miu) y una persona aliada.',
      `Guía: ${g.titulo}.${g.objetivo ? ` Objetivo: ${g.objetivo}` : ''}`,
      `Fecha de la llamada (Bogotá): ${ctx.hoy}. Escribe "fecha_siguiente_paso" como fecha concreta (por ejemplo "jueves 29 de octubre de 2026") cuando se pueda deducir.`,
      `Secciones de la guía (usa EXACTAMENTE estas claves, en este orden):\n${secciones}`,
      'Devuelve SOLO un JSON: {"resumen_general": string, "secciones": [{"clave": string, "titulo": string, "puntos": [string], "cubierta": boolean}], "siguiente_paso": string | null, "fecha_siguiente_paso": string | null, "pendientes": [string], "alerta": "persona" | "queja" | "emergencia" | null, "alerta_motivo": string | null}.',
      '"resumen_general": 2 a 4 frases. "puntos": lo que la persona DIJO en esa sección, en frases cortas y concretas (cifras, nombres de servicios, herramientas, dolores, ideas). "cubierta": true si la sección se conversó. Una sección no conversada va con puntos vacíos y cubierta false.',
      '"siguiente_paso" y "fecha_siguiente_paso": lo que acordaron, solo si se acordó. "pendientes": preguntas sin respuesta o cosas que la persona pidió.',
      'No inventes nada que no esté en la conversación. No incluyas números de teléfono, documentos ni cuentas. "alerta" solo si pidió hablar con alguien, se quejó o reportó una emergencia.',
    ].join('\n');
    try {
      const r = await http.post(`${config.apiBase}/chat/completions`, {
        model: config.modeloResumen,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: conversacion }],
        max_tokens: 4000,
      }, { headers: headers(), timeout: 60_000 });
      const json = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
      const { alerta = null, alerta_motivo: alertaMotivo = null, ...estructurado } = json && typeof json === 'object' ? json : {};
      return {
        resumen: String(estructurado.resumen_general || '').trim().slice(0, 2000) || null,
        resumenEstructurado: estructurado,
        alerta: ALERTAS.includes(alerta) ? alerta : null,
        alertaMotivo: alertaMotivo ? String(alertaMotivo).trim().slice(0, 300) : null,
      };
    } catch (error) {
      logger.error('[voz] resumen_aliado_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      return { resumen: null, resumenEstructurado: null, alerta: null, alertaMotivo: null };
    }
  }

  /**
   * Fotos de las opciones disponibles al chat, DURANTE la llamada (José Manuel,
   * 2026-10-19). Solo codigos que check_availability devolvio como disponibles
   * en esta llamada. El PMS decide si se puede (control humano, Airbnb, opt-out,
   * ventana) y lo encola por la cola de siempre; si quien llama no tiene
   * conversacion en el PMS ('sin_caso'), el mismo texto fijo y las fotos del
   * catalogo aprobado salen directo.
   */
  // Resultado de la herramienta SIN ambiguedad (tercera llamada real: Cami
  // dijo "tres opciones" cuando llego una sola): que salio AHORA, en que orden
  // global de la llamada, que no salio y por que.
  function resultadoFotos(ctx, ahora, noEnviadas = [], zonas = false) {
    const posicion = (c) => (ctx.ordenEnviado || []).indexOf(c) + 1;
    const n = ahora.length;
    return {
      status: 'ok',
      data: {
        enviadas_ahora: ahora.map((c) => ({ posicion: posicion(c), decir: comoDecirlo(c) })),
        total_enviadas_ahora: n,
        no_enviadas: noEnviadas.map((x) => ({ decir: comoDecirlo(x.codigo), motivo: x.motivo })),
        zonas_comunes_enviadas: zonas,
        todas_en_esta_llamada: (ctx.ordenEnviado || []).map((c, i) => ({ posicion: i + 1, decir: comoDecirlo(c) })),
      },
      instruccion: n
        ? `Le llegaron ${n === 1 ? 'UNA opción' : `${n} opciones`} ahora${zonas ? ' y fotos de las zonas comunes' : ''}. Di exactamente eso en UNA frase corta y espera en silencio.`
        : 'No salió nada nuevo ahora: no digas que enviaste fotos.',
    };
  }

  // LISTA DE ESPERA POR VOZ (José Manuel, 2026-10-23: "Cami de voz = Cami de
  // chat"). El PMS comprueba el horizonte, recalcula la referencia y anota con
  // el mismo mecanismo del chat; aqui solo se completan los datos que falten
  // con los de la consulta fuera del horizonte de esta llamada.
  async function anotarListaEspera(ctx, args) {
    const previo = ctx.fueraHorizonte || {};
    const datos = { arrival_date: args.arrival_date ?? previo.arrival_date ?? null, nights: args.nights ?? previo.nights ?? null,
      guests: args.guests ?? previo.guests ?? null };
    const faltan = ['arrival_date', 'nights', 'guests'].filter((k) => !datos[k]);
    if (faltan.length) return { status: 'needs_clarification', missing: faltan, reason: 'faltan_datos_lista_espera' };
    const r = await pmsSeguro('lista_espera', () => pms.vozListaEspera({ call_id: ctx.callId, check_in: datos.arrival_date,
      nights: datos.nights, guests: datos.guests }));
    if (!r) return { status: 'error', reason: 'no_se_pudo_anotar',
      instruccion: 'No quedó anotado: dile que el equipo le confirma la lista de espera por el chat de WhatsApp.' };
    return { status: r.anotado || r.ya_anotado ? 'ok' : 'not_authorized', data: r };
  }

  async function enviarOpciones(ctx, args) {
    if (!ctx.disponibilidad?.codigos?.length) return { status: 'needs_clarification', reason: 'primero_check_availability' };
    const pedidos = [...new Set((Array.isArray(args?.apartment_codes) ? args.apartment_codes : []).map(codigoApartamento).filter(Boolean))];
    const validos = pedidos.filter((c) => ctx.disponibilidad.codigos.includes(c));
    if (!validos.length) return { status: 'not_authorized', reason: 'solo_opciones_disponibles', data: { disponibles: ctx.disponibilidad.codigos.map(comoDecirlo) } };
    // P2-1: lo ya enviado en ESTA llamada no se vuelve a mandar.
    const yaEnLlamada = validos.filter((c) => ctx.fotosEnviadas.includes(c)).map((codigo) => ({ codigo, motivo: 'ya_enviada_en_esta_llamada' }));
    const codigos = validos.filter((c) => !ctx.fotosEnviadas.includes(c)).slice(0, 3);
    if (!codigos.length) return resultadoFotos(ctx, [], yaEnLlamada);
    const d = ctx.disponibilidad;
    const r = await pmsSeguro('fotos', () => pms.vozFotos({ call_id: ctx.callId, apartamentos: codigos,
      check_in: d.check_in ?? null, check_out: d.check_out ?? null, guests: d.guests ?? null }));
    if (!r) return { status: 'error', reason: 'no_se_pudieron_enviar', instruccion: 'No salió nada: no digas que enviaste fotos.' };
    const noEnviadasPms = (r.no_enviadas || []).map((x) => ({ codigo: x.codigo, motivo: x.motivo }));
    if (r.via === 'outbox') {
      ctx.fotosEnviadas.push(...r.codigos);
      ctx.ordenEnviado = [...(ctx.ordenEnviado || []), ...r.codigos];
      if (entregarAhora) Promise.resolve().then(entregarAhora).catch((error) => logger.error('[voz] entrega_fotos_fallo', { code: error?.code || null }));
      return resultadoFotos(ctx, r.codigos, [...yaEnLlamada, ...noEnviadasPms], r.zonas_comunes === true);
    }
    if (r.via === 'sin_caso' && ctx.telefono && sendImage) {
      // Mismo orden que por la cola: texto de la llamada, ficha del
      // apartamento y sus fotos (portada primero), luego el siguiente y al
      // final las zonas comunes.
      let enviadas = 0;
      let zonas = false;
      const enviadosCodigos = [];
      try {
        await sendText(ctx.telefono, r.texto);
        for (const a of r.apartamentos || []) {
          await sendText(ctx.telefono, a.ficha);
          let deEste = 0;
          for (const f of a.fotos || []) {
            const foto = photoForKey(f.clave);
            if (!foto) continue;
            await sendImage(ctx.telefono, foto.url, f.pie);
            enviadas += 1; deEste += 1;
          }
          if (deEste && a.codigo === 'EDIFICIO') zonas = true;
          else if (deEste) enviadosCodigos.push(a.codigo);
        }
      } catch (error) {
        logger.error('[voz] fotos_directo_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
      if (!enviadas) return { status: 'error', reason: 'no_se_pudieron_enviar', instruccion: 'No salió nada: no digas que enviaste fotos.' };
      ctx.fotosEnviadas.push(...enviadosCodigos);
      ctx.ordenEnviado = [...(ctx.ordenEnviado || []), ...enviadosCodigos];
      return resultadoFotos(ctx, enviadosCodigos, [...yaEnLlamada, ...noEnviadasPms], zonas);
    }
    if (r.motivo === 'ya_enviadas_en_esta_llamada') return resultadoFotos(ctx, [], [...yaEnLlamada,
      ...codigos.map((codigo) => ({ codigo, motivo: 'ya_enviada_en_esta_llamada' }))]);
    return { status: 'not_authorized', reason: r.motivo || 'no_disponible', instruccion: 'No salió nada: no digas que enviaste fotos.' };
  }

  // quote_stay solo con una disponibilidad de esta llamada para la misma
  // llegada y las mismas noches.
  function disponibilidadCubre(ctx, pmsArgs) {
    const d = ctx.disponibilidad;
    return Boolean(d && d.check_in && d.check_in === pmsArgs.arrival_date && d.nights === pmsArgs.nights);
  }

  // Siguiente paso del WhatsApp fijo (P1-2): se decide con reglas, no con el modelo.
  function siguientePaso(ctx, alerta) {
    if (ctx.requierePersona || alerta) return 'persona';
    if (ctx.huespedAirbnb) return 'estadia';
    if (ctx.fotosEnviadas.length) return 'fotos';
    if (ctx.herramientas.some((h) => h === 'quote_stay' || h === 'check_availability')) return 'cotizacion';
    return 'escribenos';
  }

  async function finalizar(ctx) {
    if (ctx.cerrada) return;
    ctx.cerrada = true;
    for (const t of ctx.timers) timers.clearTimeout(t);
    hito(ctx, 'fin');
    activas.delete(ctx.callId);
    const segundos = ctx.aceptadaAt ? Math.max(0, Math.round((now() - ctx.aceptadaAt) / 1000)) : 0;
    const costo = costoDeLlamada(segundos, config.costoUsdMinuto);
    const { resumen, alerta, alertaMotivo, resumenEstructurado = null } = await resumir(ctx);
    const alertaFinal = ctx.alerta || alerta;
    // Aliado: sin WhatsApp automatico de ventas (José Manuel le escribe).
    const paso = ctx.aliado ? null : siguientePaso(ctx, alertaFinal);
    const sinSeguimiento = ctx.personaAlMando || ctx.propietariaOnboarding || ctx.paqueteMagia || Boolean(ctx.aliado);
    // P2-6: solo nombres conocidos, cortos y a lo sumo 100.
    const herramientas = ctx.herramientas.filter((h) => NOMBRES_HERRAMIENTAS.has(h)).map((h) => h.slice(0, 60)).slice(0, 100);
    const r = await pmsSeguro('fin', () => pms.vozFin({
      call_id: ctx.callId, estado: 'terminada', motivo: ctx.motivoCierre || null, duracion_segundos: segundos,
      costo_estimado_usd: costo, transcripcion: ctx.transcripcion, resumen, requiere_persona: ctx.requierePersona,
      herramientas_usadas: herramientas, siguiente_paso: paso,
      // Con una persona al mando no se escribe en automatico (el PMS ademas lo suprime).
      enviar_seguimiento: !sinSeguimiento,
      ...(ctx.aliado && resumenEstructurado ? { resumen_estructurado: resumenEstructurado } : {}),
      // Siempre se manda la alerta final: si el aviso de la llamada fallo en
      // el PMS, sale aqui; si ya salio, el PMS no la repite (actual.alerta).
      alerta: alertaFinal || null, alerta_motivo: alertaFinal ? (ctx.alertaMotivo || alertaMotivo || null) : null,
    }));
    const directo = sinSeguimiento ? false : await enviarDirectoSiSinCaso(ctx, r);
    logger.info('[voz] llamada_terminada', { phone: mascara(ctx.telefono), segundos, costo_usd: costo,
      turnos: ctx.transcripcion.length, herramientas: herramientas.length, paso,
      seguimiento: r?.seguimiento_via === 'outbox' ? 'outbox' : directo ? 'directo' : (r?.seguimiento_via || 'sin_pms'),
      alerta: alertaFinal || null, motivo: ctx.motivoCierre || 'colgo', tiempos_ms: ctx.tiempos || {},
      ...(ctx.aliado ? { aliado: true, resumen_estructurado: Boolean(resumenEstructurado), aliado_pms: r?.aliado ?? null } : {}) });
  }

  /**
   * P2-1: llamadas que quedaron abiertas en OpenAI (el webhook se reinicio a
   * mitad). Solo las mas viejas que la duracion maxima: una mas joven puede
   * estar viva en otra instancia durante un despliegue. Se cuelgan y se
   * cierran en el PMS con el costo maximo (estimacion conservadora).
   */
  async function barrerHuerfanas() {
    if (!config.habilitada || !config.apiKey) return { colgadas: 0 };
    const r = await pmsSeguro('huerfanas', () => pms.vozHuerfanas({ mayor_a_min: Math.ceil(config.duracionMaxMin) + 5 }));
    let colgadas = 0;
    for (const llamada of r?.llamadas || []) {
      if (activas.has(llamada.call_id)) continue;
      // Llamadas de aliados (2026-10-23): el PMS da su propia duracion maxima.
      const maxMin = Number(llamada.duracion_max_min) > 0 ? Number(llamada.duracion_max_min) : config.duracionMaxMin;
      try { await openai(`/realtime/calls/${encodeURIComponent(llamada.call_id)}/hangup`); } catch (error) {
        logger.info('[voz] huerfana_hangup_fallo', { http_status: error?.response?.status || null });
      }
      await pmsSeguro('fin_huerfana', () => pms.vozFin({ call_id: llamada.call_id, estado: 'fallida', motivo: 'huerfana',
        duracion_segundos: Math.round(maxMin * 60), costo_estimado_usd: costoMaximoPorLlamada({ duracionMaxMin: maxMin, costoUsdMinuto: config.costoUsdMinuto }),
        transcripcion: [],
        enviar_seguimiento: false }));
      colgadas += 1;
    }
    if (colgadas) logger.warn('[voz] huerfanas_cerradas', { colgadas });
    return { colgadas };
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

  /**
   * CAMI LEE IMÁGENES (2026-10-23; paridad dominio 25): la persona manda una
   * imagen al chat mientras habla con Cami. Si hay una llamada activa con ese
   * teléfono, entra a la conversación de voz un aviso de sistema (sin forzar una
   * respuesta: Cami lo usa en su siguiente turno). Nunca lleva datos de un
   * documento ni de un comprobante (avisoImagenEnChat). Devuelve si se avisó.
   */
  function avisarImagenEnChat(telefono, lectura) {
    const tel = String(telefono || '').replace(/\D/g, '');
    if (!tel) return false;
    for (const ctx of activas.values()) {
      if (String(ctx?.telefono || '').replace(/\D/g, '') !== tel || !ctx.ws) continue;
      enviar(ctx, { type: 'conversation.item.create', item: { type: 'message', role: 'system',
        content: [{ type: 'input_text', text: avisoImagenEnChat(lectura || {}) }] } });
      logger.info('[voz] aviso_imagen_chat', { phone: mascara(tel), categoria: lectura?.categoria || null });
      return true;
    }
    return false;
  }

  return { handleWebhook, registrarEventosMeta, barrerHuerfanas, avisarImagenEnChat, activas, _interno: { atender, finalizar, manejarEvento, resumir, siguientePaso } };
}

module.exports = { createVozCallManager, mascara, hoyBogota, PASOS };
