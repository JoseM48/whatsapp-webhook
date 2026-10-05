'use strict';

// Keep in sync with the files under public/photos/<code>/. "01-portada" is
// always the first entry -- sent automatically with a proposal; the rest is
// the on-request gallery sent when a guest asks for more photos.
//
// FUENTE UNICA (decision de Jose Manuel, 2026-10-04): las fotos definitivas
// son las de OneDrive\Marketing\Fotos\Catalogo_aprobado\<codigo> (y
// "Zonzas Comunes" para el edificio), en el orden 1..6 que el eligio; aqui
// estan convertidas a JPG porque WhatsApp no acepta AVIF. Ninguna otra
// carpeta, seleccion anterior ni enlace de Airbnb es fuente de fotos.
const PHOTO_FILES = {
  'LF-210': ['01-portada', '02-cama', '03-balcon', '04-bano', '05-ducha', '06-cocina'],
  'LF-404': ['01-portada', '02-vista-balcon', '03-cocina', '04-balcon', '05-cama', '06-bano'],
  'LF-510': ['01-portada', '02-balcon', '03-cocina', '04-camas', '05-bano', '06-vista'],
  'LF-904': ['01-portada', '02-escritorio', '03-cama', '04-vista', '05-cocina', '06-sofa-cama'],
  'LF-1109': ['01-portada', '02-sofa-cama', '03-habitacion', '04-vista', '05-sala', '06-cocina'],
  'LF-1208': ['01-portada', '02-vista', '03-cama', '04-cocina', '05-bano', '06-ventanal']
};

// Zonas comunes del edificio: no es una unidad (nunca va como portada de una
// propuesta); Cami las pide con send_photos cuando el huesped pregunta por el
// edificio.
const BUILDING_CODE = 'EDIFICIO';
PHOTO_FILES[BUILDING_CODE] = ['01-fachada', '02-recepcion', '03-terraza', '04-ascensores', '05-lavanderia', '06-parqueadero'];

// Cambia cuando cambia el juego de fotos: la URL nueva evita que WhatsApp o un
// navegador reutilicen una imagen anterior guardada con el mismo nombre.
const PHOTO_VERSION = '20261004';

function mediaBaseUrl() {
  return String(process.env.M0_CLOSED_PILOT_MEDIA_BASE_URL || 'https://whatsapp-webhook-erom.onrender.com')
    .replace(/\/$/, '');
}

function photoUrl(code, slug) {
  return `${mediaBaseUrl()}/media/photos/${code}/${slug}.jpg?v=${PHOTO_VERSION}`;
}

function portadaUrl(code) {
  if (code === BUILDING_CODE) return null;
  const files = PHOTO_FILES[code];
  return files ? photoUrl(code, files[0]) : null;
}

function galleryUrls(code) {
  const files = PHOTO_FILES[code];
  return files ? files.map((slug) => photoUrl(code, slug)) : [];
}

module.exports = { photoUrl, portadaUrl, galleryUrls, PHOTO_FILES, BUILDING_CODE, PHOTO_VERSION };
