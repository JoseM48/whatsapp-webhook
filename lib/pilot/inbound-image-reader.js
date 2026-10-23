'use strict';

// CAMI LEE IMÁGENES (José Manuel, 2026-10-23, "enciéndelo así";
// DECISIONES_LOG.md "Cami lee imágenes"). Caso que lo origina: lead 246 (Nora)
// mandó 6+ pantallazos y Cami contestó seis veces "La imagen quedó guardada; no
// puedo leerla…".
//
// Qué hace: con la imagen YA descargada (inbound-media.js, que la guarda en el
// PMS como siempre), le pide al mismo modelo multimodal de Anthropic que usa el
// webhook (PILOT_ANTHROPIC_MODEL, misma credencial) que la CLASIFIQUE y, solo si
// es información de venta (fechas, personas, un anuncio, un pantallazo de una
// conversación o de una búsqueda), que diga en texto lo que pide el cliente.
// Ese texto entra al turno como si el cliente lo hubiera escrito, igual que la
// transcripción de una nota de voz.
//
// GUARDA DE PRIVACIDAD (parte de la decisión):
//  - documento de identidad (cédula, pasaporte, licencia...): el modelo solo
//    dice la categoría; el código DESCARTA cualquier texto que venga con ella.
//    No se extraen ni se guardan números y el turno sigue el flujo de siempre.
//  - comprobante de pago: categoría sola, texto descartado; sigue por Cartera
//    exactamente como hoy (el PMS decide por el estado del caso, no por esto).
//  - "otro" (selfie, foto sin relación): categoría sola, flujo de siempre.
//  - En la lectura de venta se tachan correos y secuencias largas de dígitos
//    (teléfonos, números de documento o de cuenta) por si el modelo los copió.
//  - Nunca se escribe en logs el texto leído: solo categoría, largo y latencia.
//
// Nunca lanza: cualquier fallo devuelve { categoria: 'no_leida' } y el turno
// sigue exactamente como antes de este cambio.


const CATEGORIAS = Object.freeze(['solicitud', 'documento_identidad', 'comprobante_pago', 'otro']);
const MIME_LEIBLES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const LECTURA_MAX = 700;

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categoria', 'lectura'],
  properties: {
    categoria: { type: 'string', enum: [...CATEGORIAS] },
    lectura: { type: ['string', 'null'] }
  }
};

const SISTEMA = [
  'You classify ONE image that a prospective guest sent by WhatsApp to a furnished-apartment rental business in Medellín (Colombia) while asking for lodging.',
  'Return "categoria":',
  '- "documento_identidad" if it looks like an identity document of any kind (cédula, passport, driver license, residence card, ID photo page), even partially. Then "lectura" MUST be null. Do not read, copy or describe any number, name or data from it.',
  '- "comprobante_pago" if it looks like a payment receipt, bank transfer, Nequi/Daviplata/PSE/bank app confirmation or deposit slip. Then "lectura" MUST be null.',
  '- "solicitud" if it carries information about what the guest wants to book or is asking: dates, number of nights or months, number of guests, a listing or ad (Airbnb, Booking, Facebook, our own), an apartment, a price they saw, a screenshot of a chat or search, a map or a list of requirements.',
  '- "otro" for anything else (selfie, landscape, meme, unrelated photo). Then "lectura" MUST be null.',
  'For "solicitud", write "lectura" in Spanish, max 3 short sentences, as if the guest were telling it: only what the image says that matters to book (dates exactly as shown, nights, guests, apartment or listing name/code, price shown with its period and platform, requirements such as pets or parking). Never copy phone numbers, emails, document or account numbers, addresses of people, or names of third parties. Do not invent anything that is not visible; if a value is unreadable, leave it out.'
].join('\n');

function outputText(response) {
  const block = (response?.content || []).find((item) => item?.type === 'text');
  if (typeof block?.text === 'string') return block.text;
  throw new Error('image_reader_output_missing');
}

// Tacha lo que pueda identificar a una persona aunque el modelo lo haya copiado:
// correos, telefonos (misma regla que minimizeUserText del interprete, ai.js) y
// cualquier secuencia de 7+ digitos seguidos (documento, cuenta), que un precio
// escrito con puntos ("3.300.000") nunca forma. No se importa ai.js para no
// arrastrar el SDK a este modulo.
function sanearLectura(texto) {
  const limpio = String(texto || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[correo omitido]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, (m) => (/^\d{4}-\d{2}-\d{2}$/.test(m) ? m : '[número omitido]'))
    .replace(/\d{7,}/g, '[número omitido]')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.slice(0, LECTURA_MAX);
}

class InboundImageReader {
  // `client` para pruebas (doble con messages.create); en produccion el mismo
  // Anthropic que construye PilotAi (index.js le pasa pilotAi.client).
  constructor({ client, model, timeoutMs = 15000, logger = console } = {}) {
    this.client = client || null;
    this.model = model;
    this.timeoutMs = Number(timeoutMs) || 15000;
    this.logger = logger;
  }

  puedeLeer(adjunto) {
    return Boolean(this.client && this.model && adjunto?.tipo === 'image' && adjunto?.estado === 'guardado'
      && adjunto?.contenido_base64 && MIME_LEIBLES.has(String(adjunto?.mime_type || '').toLowerCase().split(';')[0].trim()));
  }

  // -> { categoria, lectura|null }. `lectura` solo existe para 'solicitud'.
  async leer(adjunto) {
    if (!this.puedeLeer(adjunto)) return { categoria: 'no_leida', lectura: null, motivo: 'no_leible' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const inicio = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 600,
        system: SISTEMA,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: String(adjunto.mime_type).toLowerCase().split(';')[0].trim(), data: adjunto.contenido_base64 } },
          { type: 'text', text: 'Clasifica esta imagen y, solo si es "solicitud", di qué pide el cliente.' }
        ] }],
        output_config: { format: { type: 'json_schema', schema: ESQUEMA } }
      }, { signal: controller.signal });
      const crudo = JSON.parse(outputText(response));
      const categoria = CATEGORIAS.includes(crudo?.categoria) ? crudo.categoria : 'otro';
      // Solo la lectura de venta sobrevive; cualquier texto con otra categoria
      // se descarta aqui, sin tocar logs ni nada mas.
      const lectura = categoria === 'solicitud' ? sanearLectura(crudo?.lectura) : null;
      const resultado = categoria === 'solicitud' && !lectura
        ? { categoria: 'otro', lectura: null }
        : { categoria, lectura };
      this.logger.info('[m0-imagen] leida', { categoria: resultado.categoria, chars: resultado.lectura?.length || 0,
        latency_ms: Date.now() - inicio, model: this.model });
      return resultado;
    } catch (error) {
      this.logger.error('[m0-imagen] lectura_fallida', { aborted: controller.signal.aborted,
        status: Number(error?.status) || null, type: String(error?.type || error?.name || 'error').slice(0, 60) });
      return { categoria: 'no_leida', lectura: null, motivo: 'fallo' };
    } finally {
      clearTimeout(timer);
    }
  }
}

// RÁFAGA: el cliente manda varias imágenes seguidas (lead 246: seis). Cada una
// se lee en paralelo; el turno de cada mensaje (imagen, texto o nota de voz) ve
// las lecturas de VENTA de las imágenes de la ráfaga que Cami todavía NO ha
// respondido, así el último turno, que es el que se responde (los anteriores
// quedan superados en la entrega), tiene todo. Una lectura ya respondida no se
// repite. Solo en memoria (una instancia en Render) y solo lecturas de venta:
// nunca categorías con datos personales.
const VENTANA_RAFAGA_MS = 120_000;

function createImageBurst({ ventanaMs = VENTANA_RAFAGA_MS, now = () => Date.now() } = {}) {
  const porTelefono = new Map(); // tel -> [{ at, promesa, registrado, respondida }]
  function podar(tel) {
    const limite = now() - ventanaMs;
    const lista = (porTelefono.get(tel) || []).filter((x) => x.registrado >= limite);
    if (lista.length) porTelefono.set(tel, lista); else porTelefono.delete(tel);
    if (porTelefono.size > 2000) for (const [t] of porTelefono) if (t !== tel) porTelefono.delete(t);
    return lista;
  }
  const corteDe = (at) => { const t = Date.parse(at || ''); return Number.isFinite(t) ? t : now(); };
  return {
    registrar(tel, at, promesa) {
      const lista = podar(tel);
      lista.push({ at: corteDe(at), promesa, registrado: now(), respondida: false });
      porTelefono.set(tel, lista);
    },
    // Lecturas de venta pendientes de respuesta hasta `at` (incluida la del
    // propio mensaje), en orden de llegada.
    async lecturasPendientes(tel, at) {
      const corte = corteDe(at);
      const previas = podar(tel).filter((x) => x.at <= corte && !x.respondida).sort((a, b) => a.at - b.at);
      const resultados = await Promise.all(previas.map((x) => Promise.resolve(x.promesa).catch(() => null)));
      return resultados.filter((r) => r?.categoria === 'solicitud' && r.lectura).map((r) => r.lectura);
    },
    // El turno de `at` llegó al cliente: lo que leyó ya quedó respondido.
    marcarRespondidas(tel, at) {
      const corte = corteDe(at);
      for (const x of podar(tel)) if (x.at <= corte) x.respondida = true;
    }
  };
}

// Texto del turno: lo que el cliente "dijo" con las imagenes (y lo que escribio
// en el pie de foto, que antes se perdia), en el mismo formato para chat y nota
// de voz. `textoPropio` es el texto escrito o transcrito del mensaje actual.
function textoConLecturas(lecturas, { pie = null, textoPropio = null } = {}) {
  const partes = [];
  if (textoPropio) partes.push(String(textoPropio));
  if (pie) partes.push(`Texto que escribió con la imagen: ${String(pie).slice(0, 500)}`);
  if (lecturas.length === 1) partes.push(`[Lo que se lee en la imagen que envió el cliente] ${lecturas[0]}`);
  else if (lecturas.length > 1) {
    partes.push(`[Lo que se lee en las ${lecturas.length} imágenes que envió el cliente seguidas]`);
    lecturas.forEach((l, i) => partes.push(`${i + 1}) ${l}`));
  }
  return partes.join('\n').slice(0, 3000);
}

const MARCADOR_IMAGEN = '[M0_UNSUPPORTED_INBOUND:image]';

// Decide, para un turno YA capturado (la imagen ya quedo guardada en el PMS como
// siempre), que texto ve el modelo de Cami y que viaja al PMS:
//  - imagen y el PMS pidio leerla (`begin.leer_imagen`, que solo llega con la
//    politica lectura_imagenes_v1 encendida, el caso en etapa de venta y el
//    archivo guardado): se lee. Si hay lecturas de venta pendientes en la rafaga
//    (incluida esta), el turno lleva su texto y categoria 'solicitud'; si no,
//    sigue con el marcador de siempre y su categoria (documento de identidad,
//    comprobante u otro -> flujo de siempre en el PMS). Siempre superable por el
//    mensaje siguiente de la rafaga.
//  - texto o nota de voz con lecturas de venta pendientes (imagenes de la misma
//    rafaga que Cami aun no respondio): se agregan al texto.
//  - cualquier otro caso: el turno sale igual que antes de este cambio.
// `avisarLlamada(tel, lectura)`: paridad con la voz (dominio 25).
async function prepararTurnoImagen({ reader, burst, phone, raw, timestamp, adjunto = null, caption = null,
  begin = null, avisarLlamada = null, lecturaEnCurso = null, logger = console }) {
  const sinCambio = { text: raw, lecturaImagen: null, superablePorImagen: false };
  if (!reader || !burst || !phone) return sinCambio;
  if (raw === MARCADOR_IMAGEN) {
    if (begin?.leer_imagen !== true) return sinCambio;
    // `lecturaEnCurso`: la lectura ya arrancada (y registrada) al recibir el
    // lote, para leer en paralelo todas las imagenes de una rafaga.
    let promesa = lecturaEnCurso;
    if (!promesa) { promesa = reader.leer(adjunto); burst.registrar(phone, timestamp, promesa); }
    const propia = await promesa;
    if (typeof avisarLlamada === 'function') {
      try { avisarLlamada(phone, propia); } catch (error) {
        logger.error('[m0-imagen] aviso_llamada_fallido', { code: error?.code || null });
      }
    }
    // Un documento de identidad o un comprobante nunca se mezcla con lecturas:
    // ese turno sigue el flujo de siempre con su marcador.
    const lecturas = ['documento_identidad', 'comprobante_pago'].includes(propia.categoria)
      ? [] : await burst.lecturasPendientes(phone, timestamp);
    if (!lecturas.length) {
      return { text: raw, lecturaImagen: { categoria: propia.categoria }, superablePorImagen: true };
    }
    return { text: textoConLecturas(lecturas, { pie: caption }), lecturaImagen: { categoria: 'solicitud' },
      superablePorImagen: true };
  }
  const lecturas = await burst.lecturasPendientes(phone, timestamp);
  if (!lecturas.length) return sinCambio;
  return { text: textoConLecturas(lecturas, { textoPropio: raw }), lecturaImagen: null, superablePorImagen: false };
}

// Tras entregar: si algo del turno le llego al cliente, lo leido hasta ese
// mensaje ya quedo respondido y no se repite en el siguiente turno.
// Arranca la lectura de una imagen apenas se captura (antes de procesar el
// turno) y la registra en la rafaga. null si el PMS no pidio leerla.
function iniciarLectura({ reader, burst, phone, raw, timestamp, adjunto = null, begin = null }) {
  if (!reader || !burst || !phone || raw !== MARCADOR_IMAGEN || begin?.leer_imagen !== true) return null;
  const promesa = reader.leer(adjunto);
  burst.registrar(phone, timestamp, promesa);
  return promesa;
}

function registrarEntrega(burst, phone, timestamp, deliveries = []) {
  if (!burst || !phone) return;
  // Un turno con su respuesta superada no cuenta como respondido aunque haya
  // salido un aviso interno (las entregas no dicen a quien iban).
  const lista = (deliveries || []).filter(Boolean);
  if (lista.some((d) => d.status === 'superseded')) return;
  if (lista.some((d) => d.sent === true)) burst.marcarRespondidas(phone, timestamp);
}

module.exports = { InboundImageReader, createImageBurst, textoConLecturas, sanearLectura, prepararTurnoImagen, iniciarLectura, registrarEntrega,
  CATEGORIAS, VENTANA_RAFAGA_MS, MARCADOR_IMAGEN };
