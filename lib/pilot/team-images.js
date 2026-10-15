'use strict';

// CALENDARIO VISUAL (José Manuel, 2026-10-15). Imagenes que el PMS genera para
// las personas del EQUIPO (hoy: el calendario de operaciones en PNG). A
// diferencia de las fotos de los apartamentos (lista cerrada en este repo),
// el PMS la sirve en una ruta con un token aleatorio que vence en 24 h, y
// manda el enlace al reclamar la fila. Aqui solo se acepta:
//  - una fila del equipo (claim.equipo === true) con una CLAVE de esta lista;
//  - un enlace https cuya ruta sea exactamente /media/equipo/<32 hex>.png,
//    sin parametros, fragmento ni credenciales.
// Cualquier otra cosa no se envia (el PMS manda el texto si el webhook no
// declara X-M0-Accepts: equipo_image).

const TEAM_IMAGES = Object.freeze({
  'equipo/calendario-operaciones': /^\/media\/equipo\/[0-9a-f]{32}\.png$/
});

// { code, url } listo para enviar, o null.
function teamImage(key, link) {
  const path = Object.prototype.hasOwnProperty.call(TEAM_IMAGES, key) ? TEAM_IMAGES[key] : null;
  if (!path || typeof link !== 'string' || link.length > 500) return null;
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || !path.test(url.pathname)) return null;
  return { code: key, url: url.toString(), team: true };
}

module.exports = { TEAM_IMAGES, teamImage };
