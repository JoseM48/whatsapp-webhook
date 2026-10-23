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
// correos, telefonos (internacionales con "+" y celulares colombianos 3xx) y
// cualquier secuencia de 7+ digitos seguidos (documento, cuenta). Fechas
// ("15-11-2026", "2026-11-15 - 2026-12-15") y precios con puntos ("3.300.000",
// "2.800.000 - 3.300.000") se conservan: son lo que el cliente quiere decir
// (revision independiente 2026-10-23). No se importa ai.js para no arrastrar el
// SDK a este modulo.
function sanearLectura(texto) {
  const omitido = '[número omitido]';
  const limpio = String(texto || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[correo omitido]')
    .replace(/\+\d[\d\s().-]{7,}\d/g, omitido)
    .replace(/(?<![\d.])3\d{2}[\s-]?\d{3}[\s-]?\d{4}(?![\d.])/g, omitido)
    .replace(/\d{7,}/g, omitido)
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
// respondido y que llegaron antes que él (orden de llegada, por entrada: no por
// la marca de tiempo de Meta, que es de segundos). La respuesta de un turno de
// imagen solo se descarta si llega DESPUÉS un mensaje que va a llevar esas
// lecturas (texto/nota de voz con contenido, u otra imagen que no sea documento
// de identidad ni comprobante): así nunca se pierde una respuesta sin que otra
// la cubra (revision independiente 2026-10-23). Solo en memoria (una instancia
// en Render) y solo lecturas de venta: nunca categorías con datos personales.
const VENTANA_RAFAGA_MS = 120_000;
const SIN_LECTURAS = new Set(['documento_identidad', 'comprobante_pago']);

function createImageBurst({ ventanaMs = VENTANA_RAFAGA_MS, now = () => Date.now() } = {}) {
  const porTelefono = new Map(); // tel -> [{ seq, tipo, promesa, registrado, respondida }]
  let secuencia = 0;
  function podar(tel) {
    const limite = now() - ventanaMs;
    const lista = (porTelefono.get(tel) || []).filter((x) => x.registrado >= limite);
    if (lista.length) porTelefono.set(tel, lista); else porTelefono.delete(tel);
    if (porTelefono.size > 2000) for (const [t] of porTelefono) if (t !== tel) porTelefono.delete(t);
    return lista;
  }
  function agregar(tel, entrada) {
    const lista = podar(tel);
    lista.push(entrada);
    porTelefono.set(tel, lista);
    return entrada;
  }
  const resultado = (x) => Promise.resolve(x.promesa).catch(() => null);
  return {
    registrarImagen(tel, promesa) {
      return agregar(tel, { seq: ++secuencia, tipo: 'imagen', promesa, registrado: now(), respondida: false });
    },
    // Un texto o nota de voz con contenido (llevara las lecturas pendientes).
    // Solo se registra si hay imagenes sin responder: si no, no hace falta.
    registrarTexto(tel) {
      if (!podar(tel).some((x) => x.tipo === 'imagen' && !x.respondida)) return null;
      return agregar(tel, { seq: ++secuencia, tipo: 'texto', registrado: now(), respondida: false });
    },
    // Imagenes sin responder que llegaron hasta `entrada` (incluida) y sus
    // lecturas de venta, en orden de llegada.
    async pendientesHasta(tel, entrada) {
      const tope = entrada?.seq ?? Infinity;
      const entradas = podar(tel).filter((x) => x.tipo === 'imagen' && !x.respondida && x.seq <= tope);
      const resultados = await Promise.all(entradas.map(resultado));
      const lecturas = resultados.filter((r) => r?.categoria === 'solicitud' && r.lectura).map((r) => r.lectura);
      return { entradas, lecturas };
    },
    // ¿Llego despues de `entrada` un mensaje que llevara sus lecturas?
    async haySiguienteQueLleva(tel, entrada) {
      const despues = podar(tel).filter((x) => x.seq > (entrada?.seq ?? Infinity));
      for (const x of despues) {
        if (x.tipo === 'texto') return true;
        const r = await resultado(x);
        if (!SIN_LECTURAS.has(r?.categoria)) return true;
      }
      return false;
    },
    marcarRespondidas(entradas = []) { for (const x of entradas) x.respondida = true; }
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

// Arranca la lectura de una imagen apenas se captura (antes de procesar el
// turno) y la registra en la rafaga. null si el PMS no pidio leerla.
function iniciarLectura({ reader, burst, phone, raw, adjunto = null, begin = null }) {
  if (!reader || !burst || !phone || raw !== MARCADOR_IMAGEN || begin?.leer_imagen !== true) return null;
  return burst.registrarImagen(phone, reader.leer(adjunto));
}

// Registra un texto o nota de voz con contenido propio (no "gracias" ni "?":
// el PMS los absorbe sin respuesta propia y las lecturas se perderian).
function registrarTextoEnRafaga({ burst, phone, raw, begin = null, claimed = false }) {
  if (!burst || !phone || !claimed || /^\[M0_UNSUPPORTED_INBOUND:/.test(String(raw || ''))
    || begin?.sin_contenido_nuevo === true) return null;
  return burst.registrarTexto(phone);
}

// Decide, para un turno YA capturado (la imagen ya quedo guardada en el PMS como
// siempre), que texto ve el modelo de Cami y que viaja al PMS:
//  - imagen leida (`entrada`, solo si el PMS pidio leerla: politica
//    lectura_imagenes_v1 encendida + caso en etapa de venta + archivo guardado):
//      * documento de identidad o comprobante: marcador de siempre y su
//        categoria; flujo de siempre en el PMS, nunca superable.
//      * otra: con lecturas de venta pendientes (incluida la propia) el turno
//        lleva su texto y categoria 'solicitud'; sin ninguna, el marcador de
//        siempre. Superable solo si llega despues un mensaje que las lleve.
//  - texto o nota de voz con lecturas pendientes: se agregan a su texto.
//  - cualquier otro caso: el turno sale igual que antes de este cambio.
// `avisarLlamada(tel, lectura)`: paridad con la voz (dominio 25).
async function prepararTurnoImagen({ burst, phone, raw, caption = null, entrada = null, entradaTexto = null,
  avisarLlamada = null, logger = console }) {
  const sinCambio = { text: raw, lecturaImagen: null, superadoPorRafaga: null, incluidas: [] };
  if (!burst || !phone) return sinCambio;
  if (raw === MARCADOR_IMAGEN) {
    if (!entrada) return sinCambio;
    const propia = (await Promise.resolve(entrada.promesa).catch(() => null)) || { categoria: 'no_leida', lectura: null };
    if (typeof avisarLlamada === 'function') {
      try { avisarLlamada(phone, propia); } catch (error) {
        logger.error('[m0-imagen] aviso_llamada_fallido', { code: error?.code || null });
      }
    }
    if (SIN_LECTURAS.has(propia.categoria)) {
      // Su propia entrada queda atendida por el flujo de siempre.
      burst.marcarRespondidas([entrada]);
      return { text: raw, lecturaImagen: { categoria: propia.categoria }, superadoPorRafaga: null, incluidas: [] };
    }
    const superadoPorRafaga = () => burst.haySiguienteQueLleva(phone, entrada);
    const { entradas, lecturas } = await burst.pendientesHasta(phone, entrada);
    if (!lecturas.length) {
      // Nunca 'solicitud' sin texto leido.
      const categoria = propia.categoria === 'solicitud' ? 'otro' : propia.categoria;
      return { text: raw, lecturaImagen: { categoria }, superadoPorRafaga, incluidas: entradas };
    }
    return { text: textoConLecturas(lecturas, { pie: caption }), lecturaImagen: { categoria: 'solicitud' },
      superadoPorRafaga, incluidas: entradas };
  }
  if (!entradaTexto) return sinCambio;
  const { entradas, lecturas } = await burst.pendientesHasta(phone, entradaTexto);
  if (!lecturas.length) return { ...sinCambio, incluidas: entradas };
  return { text: textoConLecturas(lecturas, { textoPropio: raw }), lecturaImagen: null, superadoPorRafaga: null, incluidas: entradas };
}

// Tras entregar: si la respuesta del turno le llego al cliente, las imagenes que
// incluyo quedan respondidas y no se repiten en el siguiente turno. Un turno con
// su respuesta superada no cuenta aunque haya salido un aviso interno.
function registrarEntrega(burst, incluidas = [], deliveries = []) {
  if (!burst || !incluidas.length) return;
  const lista = (deliveries || []).filter(Boolean);
  if (lista.some((d) => d.status === 'superseded')) return;
  if (lista.some((d) => d.sent === true)) burst.marcarRespondidas(incluidas);
}

module.exports = { InboundImageReader, createImageBurst, textoConLecturas, sanearLectura, prepararTurnoImagen, iniciarLectura,
  registrarTextoEnRafaga, registrarEntrega,
  CATEGORIAS, VENTANA_RAFAGA_MS, MARCADOR_IMAGEN };
