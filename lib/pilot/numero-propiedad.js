'use strict';

// NÚMEROS DE PROPIEDAD (Cami multipropiedad, paquete P5; diseño
// docs/02_NEGOCIO_OPERACION/A22/DISENO_CAMI_MULTIPROPIEDAD.md §5 y §8 I1, I2, I6).
//
// Una "propiedad" es otro edificio que atiende Cami (primero A22, Studio A22
// Coliving). Sus números de WhatsApp viven en la WABA de Miu y son DATOS del PMS
// (tabla propiedad_numeros), igual que los de Equipos y de marca: sin variable de
// entorno nueva. Miu NO está en la lista: sigue siendo PHONE_NUMBER_ID.
//
// Todo apagado por defecto:
//   - sin cargador, la lista es vacía y el webhook se comporta como hoy (el número
//     de A22 se descarta como desconocido);
//   - solo un número con `atiende=true` entra a Cami (la propiedad no está
//     'apagada'); uno apagado se sigue descartando, pero su llamada se rechaza.
//
// CONTRATO QUE SE ESPERA DEL PMS (endpoint aún no existe; ver cargarDesdePms):
//   POST /api/supervised-pilot/propiedades/numeros   (firma HMAC de siempre, cuerpo {})
//   200 { numeros: [ { phone_number_id: "1234…7555", property_key: "a22",
//                      modo: "apagada"|"prueba"|"activa", activo: true } ] }
//   - nunca incluye el número de Miu; un número inactivo no viene;
//   - `atiende` = activo && modo !== 'apagada'.
//   404 = el PMS todavía no tiene la ruta: lista vacía (como hoy).

const { AsyncLocalStorage } = require('node:async_hooks');

const RUTA_NUMEROS_PROPIEDAD = '/api/supervised-pilot/propiedades/numeros';
const ID_VALIDO = /^\d{5,30}$/;

function normalizarEntradas(lista, miuId) {
  const miu = String(miuId || '').trim();
  const salida = new Map();
  for (const n of Array.isArray(lista) ? lista : []) {
    const id = String(n?.phone_number_id ?? '').trim();
    if (!ID_VALIDO.test(id) || id === miu) continue;
    const propiedad = String(n?.property_key || '').trim().slice(0, 40);
    if (!propiedad || propiedad === 'miu') continue;
    const atiende = n?.activo !== false && String(n?.modo || 'apagada') !== 'apagada';
    salida.set(id, { phone_number_id: id, property_key: propiedad, atiende });
  }
  return salida;
}

// Caché con el mismo comportamiento que la de Equipos (numero-equipos.js): lo que se
// sabe hoy sin esperar, refresco en segundo plano, y si la lectura falla se conserva
// lo último. `cargar` devuelve la lista del contrato de arriba.
function crearCacheNumerosPropiedad({ cargar = async () => [], miuId = '', ttlMs = 60_000, logger = console, ahora = Date.now } = {}) {
  let entradas = new Map();
  let vence = 0;
  let cargada = false;
  let enCurso = null;
  const actualizar = () => {
    if (enCurso) return enCurso;
    enCurso = Promise.resolve()
      .then(() => cargar())
      .then((lista) => {
        if (Array.isArray(lista)) { entradas = normalizarEntradas(lista, miuId); cargada = true; }
        vence = ahora() + ttlMs;
      })
      .catch((error) => {
        vence = ahora() + Math.min(10_000, ttlMs);
        logger.error('[propiedad] numeros_fallo', { http_status: error?.response?.status || null, code: error?.code || null });
      })
      .finally(() => { enCurso = null; });
    return enCurso;
  };
  const atendibles = () => new Set([...entradas.values()].filter((e) => e.atiende).map((e) => e.phone_number_id));
  const todos = () => new Set(entradas.keys());
  return {
    // Números cuyos mensajes entran a Cami con phone_number_id (propiedad no apagada).
    ids() { if (ahora() >= vence) actualizar(); return atendibles(); },
    // Todos los números de propiedad, también los apagados (para rechazar llamadas y
    // validar la salida).
    todosIds() { if (ahora() >= vence) actualizar(); return todos(); },
    propiedadDe(id) { return entradas.get(String(id || ''))?.property_key || null; },
    cargada: () => cargada,
    async refrescarSiVencio() { if (ahora() >= vence) await actualizar(); return atendibles(); },
  };
}

// Cargador real para cuando el PMS tenga la ruta (P2/P4). NO se conecta todavía:
// index.js usa un cargador vacío hasta que exista el endpoint.
function cargarDesdePms({ pms, pmsBaseUrl, ruta = RUTA_NUMEROS_PROPIEDAD }) {
  return async () => {
    const base = String(pmsBaseUrl || '').replace(/\/$/, '');
    if (!base) return [];
    try {
      const data = await pms.postUrl(`${base}${ruta}`, {}, { timeoutMs: 5000 });
      return Array.isArray(data?.numeros) ? data.numeros : [];
    } catch (error) {
      if (error?.response?.status === 404) return [];
      throw error;
    }
  };
}

// SALIDA POR EL NÚMERO DE LA FILA (I6, R2, R14). Cada envío del dispatcher de Cami
// corre dentro de `run(numero, fn)`; las funciones de envío de index.js piden la URL
// con `url()`. Fuera de un `run` (o con número null) la URL es la de Miu: el camino
// de Miu no cambia.
function crearSalidaPorNumero({ miuId, graphVersion = 'v20.0', numerosPropiedad = null, logger = console } = {}) {
  const als = new AsyncLocalStorage();
  const miu = String(miuId || '').trim();
  const urlDe = (id) => `https://graph.facebook.com/${graphVersion}/${id}/messages`;
  const urlMiu = urlDe(miuId);
  return {
    url() { const id = als.getStore()?.phoneNumberId; return id ? urlDe(id) : urlMiu; },
    // Para lo que responde a un mensaje entrante (el "escribiendo"): su número si es
    // de una propiedad conocida; si no, el de la fila en curso o Miu.
    urlParaEntrante(phoneNumberId) {
      const id = phoneNumberId == null ? '' : String(phoneNumberId).trim();
      if (id && id !== miu && numerosPropiedad?.todosIds?.().has(id)) return urlDe(id);
      return this.url();
    },
    numeroActual() { return als.getStore()?.phoneNumberId || null; },
    run(phoneNumberId, fn) { return als.run({ phoneNumberId: phoneNumberId || null }, fn); },
    // Decide por dónde sale una fila reclamada del outbox:
    //   - sin phone_number_id y propiedad miu o ausente -> Miu (como hoy);
    //   - sin phone_number_id y otra propiedad -> NO sale (fail-closed, R2);
    //   - phone_number_id = Miu -> Miu;
    //   - phone_number_id de una propiedad conocida -> ese número;
    //   - cualquier otro -> NO sale (un número que el webhook no reconoce).
    decidir(claim) {
      const id = claim?.phone_number_id == null ? '' : String(claim.phone_number_id).trim();
      const propiedad = claim?.property_key == null ? '' : String(claim.property_key).trim();
      if (!id) {
        if (!propiedad || propiedad === 'miu') return { modo: 'miu', phoneNumberId: null };
        return { modo: 'bloquear', motivo: 'propiedad_sin_numero' };
      }
      if (id === miu) return { modo: 'miu', phoneNumberId: null };
      if (ID_VALIDO.test(id) && numerosPropiedad?.todosIds?.().has(id)) return { modo: 'propiedad', phoneNumberId: id };
      return { modo: 'bloquear', motivo: 'numero_no_reconocido' };
    },
    logger,
  };
}

module.exports = { crearCacheNumerosPropiedad, cargarDesdePms, crearSalidaPorNumero, normalizarEntradas, RUTA_NUMEROS_PROPIEDAD };
