'use strict';

// MARCA POR PROPIEDAD (Cami multipropiedad, paquete P6; diseño
// docs/02_NEGOCIO_OPERACION/A22/DISENO_CAMI_MULTIPROPIEDAD.md §1.3, §2.1 punto 9, §4 R3 y R9).
//
// Los prompts de Cami (chat y nota de voz) dicen "Miu La Frontera", "El Poblado",
// "Medellín", "más de 2.000 reseñas" y códigos LF-. Para otra propiedad (primero
// A22, Studio A22 Coliving) esos textos no pueden salir.
//
// Regla: para 'miu' o sin propiedad, todo queda EXACTAMENTE como hoy (byte a byte:
// los prompts de Miu son las mismas constantes de siempre). Para otra propiedad, el
// texto se adapta con los datos de marca que manda el PMS en el paquete o el contexto
// del turno (`marca`); si faltan, con un texto genérico sin ninguna mención de Miu.
//
// CONTRATO QUE SE ESPERA DEL PMS (P3; hasta entonces no llega y se usa lo genérico):
//   packet.marca  y/o  context.marca  = {
//     property_key: 'a22',                 // debe coincidir con la propiedad del turno
//     nombre_marca: 'Studio A22 Coliving',
//     ciudad: 'Cali', zona: 'Pance',
//     presentacion: 'Soy Cami, …',         // opcional: frase de presentación aprobada
//     credenciales: { resenas: 12, anos_anfitrion: 3 } // opcional; sin ellas no se menciona nada
//   }
//   y la propiedad en `packet.property_key`, `context.property_key` o la fila del outbox.
// Un valor del PMS que mencione a Miu (Miu, Frontera, Poblado, Medellín, LF-…) se
// descarta: nunca se le cree a un dato que filtraría la marca de Miu.

const PROPIEDAD_MIU = 'miu';

// Códigos de apartamento por propiedad (R9). Miu: LF-NNN(N), sin cambio. A22: A22-NN(N)
// (las suites nacen con prefijo propio: A22-01…A22-12, o A22-101 si el PMS los numera
// por piso). Una propiedad sin patrón conocido no acepta ningún código (fail-closed).
const CODIGOS = Object.freeze({
  miu: Object.freeze({ patron: '^LF-[0-9]{3,4}$', extraer: /\bLF[\s-]?(\d{3,4})\b/i, prefijo: 'LF-', ejemplo: 'LF-210' }),
  a22: Object.freeze({ patron: '^A22-[0-9]{2,3}$', extraer: /\bA22[\s-]?(\d{2,3})\b/i, prefijo: 'A22-', ejemplo: 'A22-01' })
});

// Palabras que una propiedad que no es Miu nunca puede decir (R3).
const MENCIONES_MIU = [/\bmi[uú]/i, /\bm[ií]o\s+la\s+frontera\b/i, /frontera/i, /poblado/i, /medell[ií]n/i,
  /2\.000\s*rese[ñn]as/i, /\bLF-?\s?\d/i, /\bLF-/i, /aburr[aá]/i];

function mencionesMiu(texto) {
  const t = String(texto || '');
  return MENCIONES_MIU.filter((re) => re.test(t)).map((re) => String(re));
}

function claveDePropiedad(valor) {
  const k = String(valor ?? '').trim().toLowerCase().slice(0, 40);
  return k || PROPIEDAD_MIU;
}

// La propiedad del turno sale de varias pistas (fila del outbox, paquete, contexto,
// número por el que se envía). Cualquier pista de otra propiedad gana: ante la duda,
// nunca se habla como Miu. Sin ninguna pista, Miu (el camino de hoy).
function resolverPropiedadTurno(...pistas) {
  for (const p of pistas) {
    const k = String(p ?? '').trim().toLowerCase().slice(0, 40);
    if (k && k !== PROPIEDAD_MIU) return k;
  }
  return PROPIEDAD_MIU;
}

const MARCA_MIU = Object.freeze({ property_key: PROPIEDAD_MIU, es_miu: true });

function limpio(valor, max) {
  const s = String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s && mencionesMiu(s).length === 0 ? s : null;
}

/**
 * Marca de una propiedad para los prompts. 'miu' o ausente -> MARCA_MIU (los prompts
 * de hoy, sin tocar). Otra propiedad -> datos del PMS limpios o, si faltan, genérico.
 */
function marcaDePropiedad(propertyKey, datos = null) {
  const k = claveDePropiedad(propertyKey);
  if (k === PROPIEDAD_MIU) return MARCA_MIU;
  // Datos de otra propiedad no se usan (fail-closed: mejor genérico que ajeno).
  const d = datos && typeof datos === 'object'
    && (datos.property_key == null || claveDePropiedad(datos.property_key) === k) ? datos : {};
  const nombre = limpio(d.nombre_marca, 80);
  const ciudad = limpio(d.ciudad, 60);
  const zona = limpio(d.zona, 60);
  const resenas = Number.isInteger(d.credenciales?.resenas) && d.credenciales.resenas > 0 ? d.credenciales.resenas : null;
  const codigo = CODIGOS[k] || null;
  const presentacionBase = nombre ? `Soy Cami, la asistente virtual de ${nombre}` : 'Soy Cami, la asistente virtual';
  const presentacion = limpio(d.presentacion, 300)
    || `${presentacionBase}${resenas ? ` con ${resenas.toLocaleString('es-CO')} reseñas` : ''}.`;
  return Object.freeze({
    property_key: k, es_miu: false, generica: !nombre,
    nombre, ciudad, zona,
    lugar: [zona, ciudad].filter(Boolean).join(', ') || null,
    presentacion,
    codigo_patron: codigo?.patron || null,
    codigo_ejemplo: codigo?.ejemplo || null
  });
}

// Nombre para los prompts en inglés.
function nombreEn(marca) { return marca.nombre || 'this property'; }
function lugarEn(marca, prefijo = ' in ') { return marca.lugar ? `${prefijo}${marca.lugar}` : ''; }

/**
 * Adapta un texto de Miu a otra propiedad con reemplazos EXACTOS.
 * `reemplazos`: [[buscar (string), reemplazo (string | (marca) => string)], ...].
 * Con Miu devuelve el texto tal cual. Con otra propiedad, si queda alguna mención de
 * Miu lanza `marca_con_mencion_miu` (fail-closed: el llamador cae a su respaldo).
 * `faltantes` (solo para pruebas) lista los reemplazos que ya no encuentran su texto.
 */
function adaptarTexto(base, reemplazos, marca) {
  if (!marca || marca.es_miu) return base;
  let texto = String(base);
  for (const [buscar, reemplazo] of reemplazos) {
    const nuevo = typeof reemplazo === 'function' ? reemplazo(marca) : reemplazo;
    texto = texto.split(buscar).join(nuevo);
  }
  const quedan = mencionesMiu(texto);
  if (quedan.length) {
    const error = new Error(`marca_con_mencion_miu:${marca.property_key}`);
    error.code = 'marca_con_mencion_miu';
    error.menciones = quedan;
    throw error;
  }
  return texto;
}

function reemplazosFaltantes(base, reemplazos) {
  return reemplazos.filter(([buscar]) => !String(base).includes(buscar)).map(([buscar]) => buscar);
}

// Caché por marca: los prompts son textos largos y la marca cambia poco.
function conCache(construir) {
  const cache = new Map();
  return (marca) => {
    if (!marca || marca.es_miu) return construir(MARCA_MIU);
    const llave = JSON.stringify(marca);
    if (!cache.has(llave)) {
      if (cache.size > 50) cache.clear();
      cache.set(llave, construir(marca));
    }
    return cache.get(llave);
  };
}

/** Código de apartamento normalizado para la propiedad, o null. Miu: igual que siempre. */
function extraerCodigoApartamento(texto, propertyKey = PROPIEDAD_MIU) {
  const c = CODIGOS[claveDePropiedad(propertyKey)];
  if (!c) return null;
  const match = String(texto || '').match(c.extraer);
  return match ? `${c.prefijo}${match[1]}` : null;
}

function patronCodigo(propertyKey = PROPIEDAD_MIU) {
  return CODIGOS[claveDePropiedad(propertyKey)]?.patron || null;
}

function codigoValido(codigo, propertyKey = PROPIEDAD_MIU) {
  const p = patronCodigo(propertyKey);
  return Boolean(p) && new RegExp(p).test(String(codigo ?? ''));
}

// Esquema con el patrón de código de la propiedad. Miu: el MISMO objeto de siempre.
// Una propiedad sin patrón: el campo solo admite null (no puede inventar un código).
function esquemaConCodigo(esquema, propertyKey, ubicar) {
  const k = claveDePropiedad(propertyKey);
  if (k === PROPIEDAD_MIU) return esquema;
  const copia = JSON.parse(JSON.stringify(esquema));
  const campo = ubicar(copia);
  const patron = patronCodigo(k);
  if (patron) campo.pattern = patron;
  else { delete campo.pattern; campo.type = 'null'; }
  return copia;
}

module.exports = {
  PROPIEDAD_MIU, MARCA_MIU, CODIGOS, mencionesMiu, claveDePropiedad, resolverPropiedadTurno, marcaDePropiedad,
  adaptarTexto, reemplazosFaltantes, conCache, nombreEn, lugarEn,
  extraerCodigoApartamento, patronCodigo, codigoValido, esquemaConCodigo
};
