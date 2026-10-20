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
const { herramientasDeVoz, instruccionesCamiVoz, instruccionSaludo, instruccionUltimoMinuto, HERRAMIENTAS_PMS,
  NOMBRES_HERRAMIENTAS, normalizarArgsVoz, codigoApartamento, salidaDesde } = require('./cami-voz');
const { photoForKey } = require('../pilot/apartment-photos');

// Revision 2026-10-19 (P1-2, P2-5): los textos al huesped son FIJOS y viven en
// el PMS (voz-llamadas.service.js), que los encola por la cola de siempre
// (control humano, CEM). El webhook solo elige el paso y, si el PMS responde
// 'sin_caso' (quien llama nunca escribio), envia ese mismo texto fijo directo.
const PASOS = ['cotizacion', 'persona', 'estadia', 'escribenos'];
const ALERTAS = ['persona', 'queja', 'emergencia'];
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
        personaAlMando: ctx.personaAlMando, duracionMaxMin: config.duracionMaxMin, inventario: ctx.inventario }),
      audio: {
        input: { transcription: { model: config.modeloTranscripcion, language: 'es' } },
        output: { voice: config.voz },
      },
      tools: herramientasDeVoz({ sinComerciales: ctx.sinComerciales }),
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
      leadId: inicio.lead_id ?? null, transcripcion: [], herramientas: [], requierePersona: false, alerta: null,
      inventario: inicio.inventario ?? null, disponibilidad: null, fotosEnviadas: [],
      aceptadaAt: null, cerrada: false, ws: null, timers: [],
    };
    ctx.sinComerciales = ctx.huespedAirbnb || ctx.personaAlMando;
    ctx.permitidas = new Set(herramientasDeVoz({ sinComerciales: ctx.sinComerciales }).map((h) => h.name));
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
      lead: ctx.leadId != null, airbnb: ctx.huespedAirbnb, persona_al_mando: ctx.personaAlMando });
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
        // P1-1: aviso inmediato a José Manuel por el mecanismo de avisos internos.
        ctx.requierePersona = true;
        const tipo = ALERTAS.includes(args?.tipo) ? args.tipo : 'persona';
        ctx.alerta = ctx.alerta || tipo;
        ctx.alertaMotivo = ctx.alertaMotivo || String(args?.motivo || '').slice(0, 300) || null;
        const aviso = await pmsSeguro('alerta', () => pms.vozAlerta({ call_id: ctx.callId, tipo,
          motivo: String(args?.motivo || '').slice(0, 300) || null }));
        resultado = { status: 'ok', data: { aviso_enviado: aviso?.aviso_encolado === true || aviso?.duplicado === true } };
      } else if (item.name === 'enviar_opciones_al_chat' && ctx.permitidas.has(item.name)) {
        resultado = await enviarOpciones(ctx, args);
      } else if (HERRAMIENTAS_PMS.has(item.name) && ctx.permitidas.has(item.name)) {
        // El esquema de la voz se traduce al contrato del PMS (cami-voz.js).
        const pmsArgs = normalizarArgsVoz(item.name, args);
        resultado = await executePmsTool(item.name, pmsArgs, { as_of: ctx.hoy, proposal_snapshot: null });
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

  // Resumen SOLO para el equipo (CEM y ventana de Cami-texto) y deteccion de
  // queja o emergencia. Nada de lo que escribe el modelo se le envia al huesped.
  async function resumir(ctx) {
    const huesped = ctx.transcripcion.filter((t) => t.quien === 'huesped');
    if (!huesped.length) return { resumen: null, alerta: null, alertaMotivo: null };
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

  /**
   * Fotos de las opciones disponibles al chat, DURANTE la llamada (José Manuel,
   * 2026-10-19). Solo codigos que check_availability devolvio como disponibles
   * en esta llamada. El PMS decide si se puede (control humano, Airbnb, opt-out,
   * ventana) y lo encola por la cola de siempre; si quien llama no tiene
   * conversacion en el PMS ('sin_caso'), el mismo texto fijo y las fotos del
   * catalogo aprobado salen directo.
   */
  async function enviarOpciones(ctx, args) {
    if (!ctx.disponibilidad?.codigos?.length) return { status: 'needs_clarification', reason: 'primero_check_availability' };
    const pedidos = [...new Set((Array.isArray(args?.apartment_codes) ? args.apartment_codes : []).map(codigoApartamento).filter(Boolean))];
    const validos = pedidos.filter((c) => ctx.disponibilidad.codigos.includes(c));
    if (!validos.length) return { status: 'not_authorized', reason: 'solo_opciones_disponibles', data: { disponibles: ctx.disponibilidad.codigos } };
    // P2-1: lo ya enviado en esta llamada no se vuelve a mandar.
    const codigos = validos.filter((c) => !ctx.fotosEnviadas.includes(c)).slice(0, 3);
    if (!codigos.length) return { status: 'ok', reason: 'ya_enviadas_nada_nuevo', data: { enviadas: [], ya_enviadas: validos } };
    const d = ctx.disponibilidad;
    const r = await pmsSeguro('fotos', () => pms.vozFotos({ call_id: ctx.callId, apartamentos: codigos,
      check_in: d.check_in ?? null, check_out: d.check_out ?? null, guests: d.guests ?? null }));
    if (!r) return { status: 'error', reason: 'no_se_pudieron_enviar' };
    if (r.via === 'outbox') {
      ctx.fotosEnviadas.push(...r.codigos);
      if (entregarAhora) Promise.resolve().then(entregarAhora).catch((error) => logger.error('[voz] entrega_fotos_fallo', { code: error?.code || null }));
      return { status: 'ok', data: { enviadas: r.codigos } };
    }
    if (r.via === 'sin_caso' && ctx.telefono && sendImage) {
      let enviadas = 0;
      try {
        await sendText(ctx.telefono, r.texto);
        for (const f of r.fotos || []) {
          const foto = photoForKey(f.clave);
          if (!foto) continue;
          await sendImage(ctx.telefono, foto.url, f.pie);
          enviadas += 1;
        }
      } catch (error) {
        logger.error('[voz] fotos_directo_fallo', { code: error?.code || null, http_status: error?.response?.status || null });
      }
      if (!enviadas) return { status: 'error', reason: 'no_se_pudieron_enviar' };
      ctx.fotosEnviadas.push(...r.codigos);
      return { status: 'ok', data: { enviadas: r.codigos } };
    }
    // P2-2: nada nuevo (ya enviadas) no es un error: el modelo debe saber que no salio nada.
    if (r.motivo === 'ya_enviadas_en_esta_llamada' || r.motivo === 'fotos_ya_enviadas_24h') {
      return { status: 'ok', reason: 'ya_enviadas_nada_nuevo', data: { enviadas: [] } };
    }
    return { status: 'not_authorized', reason: r.motivo || 'no_disponible' };
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
    activas.delete(ctx.callId);
    const segundos = ctx.aceptadaAt ? Math.max(0, Math.round((now() - ctx.aceptadaAt) / 1000)) : 0;
    const costo = costoDeLlamada(segundos, config.costoUsdMinuto);
    const { resumen, alerta, alertaMotivo } = await resumir(ctx);
    const alertaFinal = ctx.alerta || alerta;
    const paso = siguientePaso(ctx, alertaFinal);
    // P2-6: solo nombres conocidos, cortos y a lo sumo 100.
    const herramientas = ctx.herramientas.filter((h) => NOMBRES_HERRAMIENTAS.has(h)).map((h) => h.slice(0, 60)).slice(0, 100);
    const r = await pmsSeguro('fin', () => pms.vozFin({
      call_id: ctx.callId, estado: 'terminada', motivo: ctx.motivoCierre || null, duracion_segundos: segundos,
      costo_estimado_usd: costo, transcripcion: ctx.transcripcion, resumen, requiere_persona: ctx.requierePersona,
      herramientas_usadas: herramientas, siguiente_paso: paso,
      // Con una persona al mando no se escribe en automatico (el PMS ademas lo suprime).
      enviar_seguimiento: !ctx.personaAlMando,
      // Siempre se manda la alerta final: si el aviso de la llamada fallo en
      // el PMS, sale aqui; si ya salio, el PMS no la repite (actual.alerta).
      alerta: alertaFinal || null, alerta_motivo: alertaFinal ? (ctx.alertaMotivo || alertaMotivo || null) : null,
    }));
    const directo = ctx.personaAlMando ? false : await enviarDirectoSiSinCaso(ctx, r);
    logger.info('[voz] llamada_terminada', { phone: mascara(ctx.telefono), segundos, costo_usd: costo,
      turnos: ctx.transcripcion.length, herramientas: herramientas.length, paso,
      seguimiento: r?.seguimiento_via === 'outbox' ? 'outbox' : directo ? 'directo' : (r?.seguimiento_via || 'sin_pms'),
      alerta: alertaFinal || null, motivo: ctx.motivoCierre || 'colgo' });
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
      try { await openai(`/realtime/calls/${encodeURIComponent(llamada.call_id)}/hangup`); } catch (error) {
        logger.info('[voz] huerfana_hangup_fallo', { http_status: error?.response?.status || null });
      }
      await pmsSeguro('fin_huerfana', () => pms.vozFin({ call_id: llamada.call_id, estado: 'fallida', motivo: 'huerfana',
        duracion_segundos: Math.round(config.duracionMaxMin * 60), costo_estimado_usd: costoMax, transcripcion: [],
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

  return { handleWebhook, registrarEventosMeta, barrerHuerfanas, activas, _interno: { atender, finalizar, manejarEvento, resumir, siguientePaso } };
}

module.exports = { createVozCallManager, mascara, hoyBogota, PASOS };
