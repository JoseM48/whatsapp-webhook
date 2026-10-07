'use strict';

// GUIA DEL HUESPED (José Manuel, 2026-10-07; DECISIONES_LOG "Confirmaciones
// ... Si a todo", punto c). Documentos que el PMS puede pedir que se le envien
// a un huesped, por CLAVE: lista cerrada.
//
// El PDF incluye la direccion exacta del edificio, asi que NO vive en este
// repositorio (es publico): lo sirve el PMS (repositorio privado) en una ruta
// exacta con un segmento no adivinable, y el PMS manda el enlace al reclamar.
// Aqui solo se acepta un enlace https cuya ruta tenga la forma esperada para
// esa clave; cualquier otra cosa no se envia.

const GUEST_DOCUMENTS = Object.freeze({
  guia_huesped_v1: Object.freeze({
    filename: 'Guía del sector - Mío La Frontera.pdf',
    path: /^\/media\/guia\/[0-9a-f]{24}\/guia-sector-mio-la-frontera-v1\.pdf$/
  })
});

// { link, filename } listo para enviar, o null si la clave no esta en la lista
// o el enlace no es el esperado.
function guestDocument(key, link) {
  const doc = Object.prototype.hasOwnProperty.call(GUEST_DOCUMENTS, key) ? GUEST_DOCUMENTS[key] : null;
  if (!doc || typeof link !== 'string' || link.length > 500) return null;
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || !doc.path.test(url.pathname)) return null;
  return { key, link: url.toString(), filename: doc.filename };
}

// Cuerpo de Meta Cloud API para un documento (type 'document').
function documentMessagePayload(to, { link, filename, caption }) {
  const document = { link, filename };
  if (caption) document.caption = String(caption).slice(0, 1024);
  return { messaging_product: 'whatsapp', to, type: 'document', document };
}

module.exports = { GUEST_DOCUMENTS, guestDocument, documentMessagePayload };
