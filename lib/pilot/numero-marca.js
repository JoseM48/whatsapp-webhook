'use strict';

// NÚMEROS DE MARCA DE TENGO CAMELLO (Quedó Bien, GO José Manuel 2026-11-11; PMS
// migración 1201: equipos_numeros.tipo='marca' con su negocio).
//
// Un número de marca atiende a DESCONOCIDOS (clientes de la marca) y a las personas
// del negocio (el PMS decide el modo). Los números son datos en el PMS, no variables:
// el webhook lee la lista con caché y conserva lo último si el PMS falla. Lo que
// llega a uno de estos números nunca entra a Miu, al 7355, al 7354 ni a Equipos.
// Cada mensaje va firmado al PMS (/api/marcas/*) y lo que el PMS responde sale DESDE
// el número que lo recibió: texto, botones reales (máximo 3) o imagen.
// Cola qb_outbox (2026-11-11, brecha 4 de la simulación de TenGo): fuera de la ventana
// de 24 h el PMS entrega {plantilla} y sale como plantilla de Meta; las fotos de una
// salida (`documentos`, ids de equipos_documentos) se piden al PMS, se suben a Meta
// desde el mismo número y salen como imagen después del texto.
// El teléfono nunca va a logs.

const { capturarConRespaldo } = require('./inbound-media');
const { crearCacheNumeros, cuerpoInteractivo, cuerpoPlantilla, crearMemoriaRemitentes } = require('./numero-equipos');

const RUTA_NUMEROS = '/api/marcas/numeros';
const RUTA_PUEDE = '/api/marcas/puede';
const RUTA_INBOUND = '/api/marcas/whatsapp/inbound';
const RUTA_ESTADOS = '/api/marcas/whatsapp/estados';
const RUTA_RECLAMAR = '/api/marcas/whatsapp/outbox/reclamar';
const rutaResultado = (id) => `/api/marcas/whatsapp/outbox/${encodeURIComponent(id)}/resultado`;
const rutaDocumento = (id) => `/api/marcas/whatsapp/outbox/${encodeURIComponent(id)}/documento`;
const MAX_FOTOS = 5;
const MAX_FOTO_BYTES = 5 * 1024 * 1024; // límite de Meta para imágenes
const MIME_FOTO = new Set(['image/jpeg', 'image/png']);
const ID_META = /^\d{1,40}$/;
const ETIQUETA = '[marca]';
// El cliente de la marca se trata de usted (PLAN_QUEDO_BIEN_V1, sección 5).
const TEXTO_FALLA_PMS = 'Tuvimos un problema y no pudimos guardar su mensaje. Por favor, envíelo de nuevo en un rato.';

function crearCacheNumerosMarca(opciones) {
  return crearCacheNumeros({ ...opciones, ruta: RUTA_NUMEROS, etiqueta: ETIQUETA, vacioSi404: true });
}

/**
 * Saca del cuerpo de Meta los cambios de los números de marca. Lo demás sigue
 * intacto (mismo objeto si no había nada de marca), para el ruteo de siempre.
 * Un id de Miu, del 7355 o del 7354 nunca se toma como marca aunque esté en la lista.
 */
function separarMarca(body, { marcaIds, reservados = [] } = {}) {
  const ids = marcaIds instanceof Set ? marcaIds : new Set();
  const propios = new Set(reservados.map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size) return { body, marcaChanges: [] };
  const marcaChanges = [];
  let filtrado = false;
  const entries = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const changes = [];
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value?.metadata?.phone_number_id;
      const id = v == null || v === '' ? null : String(v);
      if (id && ids.has(id) && !propios.has(id)) { marcaChanges.push(change); filtrado = true; continue; }
      changes.push(change);
    }
    if (changes.length) entries.push(changes.length === (entry.changes || []).length ? entry : { ...entry, changes });
  }
  if (!filtrado) return { body, marcaChanges };
  // Todo era de marca: no queda nada para el ruteo de siempre (null, nunca un cuerpo vacío).
  return { body: entries.length ? { ...body, entry: entries } : null, marcaChanges };
}

// Imagen: por media id de Meta (subida antes) o por enlace https, con un pie corto.
// Una URL rara no sale.
function cuerpoImagen(to, { imagen }) {
  if (imagen?.media_id != null) {
    const id = String(imagen.media_id);
    if (!ID_META.test(id)) throw Object.assign(new Error('imagen_invalida'), { code: 'imagen_invalida' });
    const pie = String(imagen?.caption || '').trim().slice(0, 1024);
    return { messaging_product: 'whatsapp', to, type: 'image', image: { id, ...(pie ? { caption: pie } : {}) } };
  }
  const link = String(imagen?.url || '');
  if (!/^https:\/\/[^\s]+$/.test(link) || link.length > 2000) throw Object.assign(new Error('imagen_invalida'), { code: 'imagen_invalida' });
  const caption = String(imagen?.caption || '').trim().slice(0, 1024);
  return { messaging_product: 'whatsapp', to, type: 'image', image: { link, ...(caption ? { caption } : {}) } };
}

// LISTA INTERACTIVA (carta de Pipa y Mima, 2026-11-12). Contrato del PMS:
// salida.lista = { boton, secciones: [{ titulo, filas: [{ id, title (≤24), description? (≤72) }] }] }.
// Límites de Meta: máximo 10 filas en total, botón ≤ 20, título de sección ≤ 24 (obligatorio si hay
// varias secciones), cuerpo ≤ 1024. Sin filas válidas devuelve null y la salida va como texto.
const MAX_FILAS_LISTA = 10;
function cuerpoLista(to, { texto, lista }) {
  const secciones = [];
  let filas = 0;
  for (const s of Array.isArray(lista?.secciones) ? lista.secciones : []) {
    const rows = [];
    for (const f of Array.isArray(s?.filas) ? s.filas : []) {
      if (filas >= MAX_FILAS_LISTA) break;
      const id = String(f?.id ?? '').slice(0, 200);
      const title = String(f?.title ?? '').trim().slice(0, 24);
      if (!id || !title) continue;
      const description = String(f?.description ?? '').trim().slice(0, 72);
      rows.push({ id, title, ...(description ? { description } : {}) });
      filas += 1;
    }
    const titulo = String(s?.titulo ?? '').trim().slice(0, 24);
    if (rows.length) secciones.push({ ...(titulo ? { title: titulo } : {}), rows });
  }
  if (!filas) return null;
  if (secciones.length > 1) secciones.forEach((s, k) => { if (!s.title) s.title = `Opciones ${k + 1}`; });
  const body = String(texto || '').trim().slice(0, 1024) || 'Elija una opción.';
  const button = String(lista?.boton || '').trim().slice(0, 20) || 'Ver opciones';
  return { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button, sections: secciones } } };
}

/**
 * Cuerpo de Meta para una salida del PMS: plantilla (fuera de 24 h; el PMS la manda
 * solo con un nombre aprobado), imagen, lista, botones o texto.
 */
function cuerpoSalidaMarca(to, salida) {
  if (salida?.plantilla) return cuerpoPlantilla(to, salida.plantilla);
  if (salida?.imagen) return cuerpoImagen(to, salida);
  if (salida?.lista) { const c = cuerpoLista(to, salida); if (c) return c; }
  const botones = Array.isArray(salida?.botones) ? salida.botones.filter((b) => b && b.id != null && String(b.title || '').trim()) : [];
  if (botones.length) return cuerpoInteractivo(to, { texto: salida.texto, botones });
  return { messaging_product: 'whatsapp', to, text: { body: String(salida?.texto || '').slice(0, 4096) } };
}

const tieneContenido = (s) => Boolean(String(s?.texto || '').trim() || s?.imagen?.url);

// Con la marca, el PMS es quien decide si se responde; la IA del PMS puede tardar.
// Igual que Equipos: se espera salvo que el cuerpo traiga algo más (nunca retrasa a Miu).
const debeEsperarMarca = (ruteo) => !ruteo.miuBody && !ruteo.tengoChanges.length && !ruteo.demoChanges.length && !ruteo.equiposChanges.length;

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

/**
 * Atiende los cambios de números de marca.
 * deps: { pms, pmsBaseUrl, enviar(phoneNumberId, to, salida), extractMetaMessages, logger, transcribirAudio?, descargarAdjunto?, memoria? }
 */
async function atenderMarca(changes, { pms, pmsBaseUrl, enviar, extractMetaMessages, logger = console, transcribirAudio = null, descargarAdjunto = null, memoria = null }) {
  const resultado = { mensajes: 0, enviados: 0 };
  const base = String(pmsBaseUrl || '').replace(/\/$/, '');
  if (!base) { logger.error(`${ETIQUETA} pms_no_configurado`); return resultado; }
  for (const change of changes) {
    const phoneNumberId = String(change?.value?.metadata?.phone_number_id || '');
    const numeroMostrado = change?.value?.metadata?.display_phone_number ? String(change.value.metadata.display_phone_number).slice(0, 40) : null;
    if (String(change?.field || '') === 'calls' || (change?.value?.calls || []).length) logger.warn(`${ETIQUETA} evento_llamada_sin_chat`, {});
    if ((change?.value?.statuses || []).length) {
      try {
        await pms.postUrl(`${base}${RUTA_ESTADOS}`, { phone_number_id: phoneNumberId, statuses: change.value.statuses.map((s) => ({
          id: s?.id, status: s?.status, timestamp: s?.timestamp, recipient_id: s?.recipient_id,
          ...(s?.errors ? { errors: s.errors.map((e) => ({ code: e?.code, title: e?.title })) } : {}) })) });
      } catch (error) {
        logger.error(`${ETIQUETA} estados_fallo`, { http_status: error?.response?.status || null, code: error?.code || null });
      }
    }
    for (const m of extractMetaMessages({ entry: [{ changes: [change] }] })) {
      resultado.mensajes += 1;
      // Con varias marcas, el mismo cliente puede escribirle a dos: la memoria es por número y teléfono.
      const clave = `${phoneNumberId}:${m.from}`;
      // Antes de gastar: el PMS dice si este remitente puede mandar archivos o notas
      // de voz hoy (un cliente nuevo sí, con topes). Si el PMS no contesta, no se gasta.
      let puede = { documentos: false, notas_voz: false };
      const esAudio = !m.text && m.messageType === 'audio' && m.audio?.id;
      const esArchivo = m.media && m.media.tipo !== 'sticker';
      if (esAudio || esArchivo) {
        try {
          puede = await pms.postUrl(`${base}${RUTA_PUEDE}`, { phone_number_id: phoneNumberId, from: m.from }, { timeoutMs: 8000 }) || puede;
        } catch (error) {
          logger.error(`${ETIQUETA} puede_fallo`, { phone: mascara(m.from), http_status: error?.response?.status || null, code: error?.code || null });
        }
      }
      let texto = m.text || '';
      if (esAudio && transcribirAudio && puede.notas_voz === true) {
        try {
          texto = String(await transcribirAudio(m.audio.id) || '');
        } catch (error) {
          texto = '';
          logger.error(`${ETIQUETA} audio_transcripcion_fallo`, { phone: mascara(m.from), code: error?.code || null });
        }
      }
      try {
        const adjunto = !esArchivo ? null
          : descargarAdjunto && puede.documentos === true ? await descargarAdjunto(m.media)
            : { tipo: m.media.tipo, estado: 'no_descargado', motivo: 'sin_permiso_o_tope' };
        const payload = { phone_number_id: phoneNumberId, numero_mostrado: numeroMostrado, from: m.from, text: texto, message_id: m.messageId, occurred_at: m.timestamp,
          contact_name: m.name || null, message_type: m.messageType || null,
          ...(m.botonId || m.listaId ? { boton_id: m.botonId || m.listaId } : {}), ...(m.contactos?.length ? { contactos: m.contactos } : {}), ...(adjunto ? { adjunto } : {}) };
        const data = await capturarConRespaldo((cuerpo) => pms.postUrl(`${base}${RUTA_INBOUND}`, cuerpo, { timeoutMs: 45000 }), payload, logger);
        // Solo a quien el PMS ya le respondió se le avisa si luego falla: con la política
        // apagada el número no responde a nadie, ni siquiera con el aviso de falla.
        if (data?.responder === true) memoria?.conocido(clave);
        memoria?.bien(clave);
        const salida = data?.responder === true && Array.isArray(data.mensajes) ? data.mensajes : [];
        for (const s of salida) {
          if (!tieneContenido(s)) continue;
          // Ya quedó registrado en el PMS: si falla el envío no se pide reenviarlo.
          try {
            await enviar(phoneNumberId, m.from, s);
            resultado.enviados += 1;
          } catch (error) {
            logger.error(`${ETIQUETA} respuesta_no_enviada`, { phone: mascara(m.from), message_id: m.messageId || null, code: error?.code || null });
          }
        }
        logger.info(`${ETIQUETA} mensaje`, { phone: mascara(m.from), action: data?.action || null, enviados: salida.length });
      } catch (error) {
        logger.error(`${ETIQUETA} mensaje_no_atendido`, { phone: mascara(m.from), message_id: m.messageId || null, tipo: m.messageType || null, code: error?.code || null, http_status: error?.response?.status || null });
        if (memoria?.debeAvisar(clave)) {
          try {
            await enviar(phoneNumberId, m.from, { texto: TEXTO_FALLA_PMS });
            logger.info(`${ETIQUETA} aviso_falla_enviado`, { phone: mascara(m.from) });
          } catch (e) {
            logger.error(`${ETIQUETA} aviso_falla_fallo`, { phone: mascara(m.from), code: e?.code || null });
          }
        }
      }
    }
  }
  return resultado;
}

/**
 * Sube una foto a Meta (POST /{phone_number_id}/media, multipart) y devuelve el media id.
 * deps: { post(url, cuerpo, opciones) al estilo de axios.post, token, version? }.
 */
function crearSubirMedia({ post, token, version = 'v20.0' }) {
  return async function subirMedia(phoneNumberId, { mimeType, buffer, nombre = 'foto' }) {
    if (!ID_META.test(String(phoneNumberId || ''))) throw Object.assign(new Error('numero_invalido'), { code: 'numero_invalido' });
    const forma = new FormData();
    forma.append('messaging_product', 'whatsapp');
    forma.append('type', mimeType);
    forma.append('file', new Blob([buffer], { type: mimeType }), `${nombre}.${mimeType === 'image/png' ? 'png' : 'jpg'}`);
    const r = await post(`https://graph.facebook.com/${version}/${phoneNumberId}/media`, forma, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    const id = r?.data?.id;
    if (!id) throw Object.assign(new Error('media_sin_id'), { code: 'media_sin_id' });
    return String(id);
  };
}

/**
 * Fotos de una salida cuyo texto ya salió: cada id se pide al PMS (ruta firmada
 * /documento), se sube a Meta desde el mismo número y sale como imagen. Una foto que
 * falla no frena las demás. -> [{documento_id, resultado, error?}]
 */
async function enviarFotosSalida(s, desde, { pms, base, enviar, subirMedia, logger }) {
  const ids = (Array.isArray(s?.documentos) ? s.documentos : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, MAX_FOTOS);
  const res = [];
  for (const documentoId of ids) {
    try {
      if (!subirMedia) throw Object.assign(new Error('sin_subida_de_medios'), { code: 'sin_subida_de_medios' });
      const d = await pms.postUrl(`${base}${rutaDocumento(s.id)}`, { documento_id: documentoId }, { timeoutMs: 20000 });
      const mimeType = String(d?.mime_type || '').toLowerCase();
      if (!MIME_FOTO.has(mimeType) || typeof d?.contenido_base64 !== 'string') throw Object.assign(new Error('documento_no_es_foto'), { code: 'documento_no_es_foto' });
      const buffer = Buffer.from(d.contenido_base64, 'base64');
      if (!buffer.length || buffer.length > MAX_FOTO_BYTES) throw Object.assign(new Error('foto_tamano_invalido'), { code: 'foto_tamano_invalido' });
      const mediaId = await subirMedia(desde, { mimeType, buffer, nombre: `foto-${documentoId}` });
      await enviar(desde, s.to, { imagen: { media_id: mediaId } });
      res.push({ documento_id: documentoId, resultado: 'enviado' });
    } catch (e) {
      const code = String(e?.code || (e?.response?.status ? `http_${e.response.status}` : 'error')).slice(0, 60);
      res.push({ documento_id: documentoId, resultado: 'error', error: code });
      logger.error(`${ETIQUETA} foto_no_enviada`, { id: s.id, documento_id: documentoId, code, http_status: e?.response?.status || null });
    }
  }
  return res;
}

/**
 * Cola qb_outbox: reclama hasta 10 salidas y las envía desde el phone_number_id que
 * trae cada una (el PMS solo encola números de marca activos). Reporta cada resultado:
 * {resultado: 'enviado' | 'error' | 'incierto'}; un reporte perdido lo resuelve el PMS.
 * Con plantilla sale solo la plantilla. Con fotos: primero el texto y luego cada foto;
 * si alguna falla, la salida queda 'enviado' con error 'fotos_no_enviadas:<n>/<total>'
 * y el detalle en `documentos`.
 */
async function despacharSalidasMarca({ pms, pmsBaseUrl, enviar, numerosMarca = null, clasificarFallo, subirMedia = null, logger = console }) {
  const base = String(pmsBaseUrl || '').replace(/\/$/, '');
  if (!base) return { enviados: 0, fallidos: 0, inciertos: 0 };
  // Sin la lista leída (PMS caído) o sin números de marca no se reclama: una salida reclamada
  // sin poder enviarla se perdería como error.
  if (numerosMarca && (!numerosMarca.cargada() || !numerosMarca.ids().size)) return { enviados: 0, fallidos: 0, inciertos: 0 };
  const data = await pms.postUrl(`${base}${RUTA_RECLAMAR}`, { limite: 10 });
  const salidas = Array.isArray(data?.salidas) ? data.salidas : [];
  let enviados = 0, fallidos = 0, inciertos = 0;
  for (const s of salidas) {
    let cuerpo;
    const desde = String(s?.phone_number_id || '');
    try {
      // Defensa: nunca se envía desde un número que el webhook no conoce como de marca.
      if (!desde || (numerosMarca && !numerosMarca.ids().has(desde))) throw Object.assign(new Error('numero_no_es_de_marca'), { code: 'numero_no_es_de_marca', permanente: true });
      if (!tieneContenido(s) && !s?.plantilla) throw Object.assign(new Error('salida_vacia'), { code: 'salida_vacia', permanente: true });
      // Fuera de 24 h Meta solo acepta la plantilla: ni texto libre, ni botones, ni fotos.
      const providerReference = await enviar(desde, s.to, s.plantilla ? { plantilla: s.plantilla } : s);
      cuerpo = { resultado: 'enviado', provider_reference: providerReference || null };
    } catch (e) {
      cuerpo = e?.permanente || e?.code === 'plantilla_invalida' || e?.code === 'imagen_invalida' || e?.code === 'invalid_recipient'
        ? { resultado: 'error', error: String(e.code).slice(0, 80) } : clasificarFallo(e);
    }
    if (cuerpo.resultado === 'enviado' && !s.plantilla && Array.isArray(s.documentos) && s.documentos.length) {
      const fotos = await enviarFotosSalida(s, desde, { pms, base, enviar, subirMedia, logger });
      const fallidas = fotos.filter((f) => f.resultado !== 'enviado').length;
      cuerpo = { ...cuerpo, documentos: fotos, ...(fallidas ? { error: `fotos_no_enviadas:${fallidas}/${fotos.length}` } : {}) };
    }
    try {
      await pms.postUrl(`${base}${rutaResultado(s.id)}`, cuerpo);
    } catch (e) {
      logger.error(`${ETIQUETA} resultado_fallo`, { id: s.id, code: e?.code || null });
    }
    if (cuerpo.resultado === 'enviado') enviados += 1; else if (cuerpo.resultado === 'error') fallidos += 1; else inciertos += 1;
    logger.info(`${ETIQUETA} salida`, { id: s.id, phone: mascara(s.to), resultado: cuerpo.resultado });
  }
  return { enviados, fallidos, inciertos };
}

module.exports = { atenderMarca, separarMarca, crearCacheNumerosMarca, crearMemoriaRemitentesMarca: crearMemoriaRemitentes, cuerpoSalidaMarca, despacharSalidasMarca, debeEsperarMarca,
  crearSubirMedia, TEXTO_FALLA_PMS, RUTA_NUMEROS, RUTA_PUEDE, RUTA_INBOUND, RUTA_ESTADOS, RUTA_RECLAMAR, rutaResultado, rutaDocumento };
