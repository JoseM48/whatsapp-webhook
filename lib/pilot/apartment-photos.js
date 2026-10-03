'use strict';

// Keep in sync with the files under public/photos/<code>/. "01-portada" is
// always the first entry -- sent automatically with a proposal; the rest is
// the on-request gallery sent when a guest asks for more photos.
const PHOTO_FILES = {
  'LF-210': ['01-portada', '02-balcon', '03-cama', '04-cocina', '05-bano', '06-tv'],
  'LF-404': ['01-portada', '02-balcon', '03-cama', '04-cocina', '05-bano', '06-sofa'],
  'LF-1208': ['01-portada', '02-ventanal', '03-cama', '04-cocina', '05-bano', '06-lavadora'],
  // 2026-10-03: fotos de los anuncios de Airbnb, aprobadas por Jose Manuel
  // (guardadas por el en OneDrive\Marketing\Fotos\Catalogo_aprobado).
  'LF-510': ['01-portada', '02-balcon', '03-cocina', '04-camas', '05-bano', '06-vista'],
  'LF-904': ['01-portada', '02-escritorio', '03-cama', '04-vista', '05-cocina', '06-sofa-cama']
};

function mediaBaseUrl() {
  return String(process.env.M0_CLOSED_PILOT_MEDIA_BASE_URL || 'https://whatsapp-webhook-erom.onrender.com')
    .replace(/\/$/, '');
}

function photoUrl(code, slug) {
  return `${mediaBaseUrl()}/media/photos/${code}/${slug}.jpg`;
}

function portadaUrl(code) {
  const files = PHOTO_FILES[code];
  return files ? photoUrl(code, files[0]) : null;
}

function galleryUrls(code) {
  const files = PHOTO_FILES[code];
  return files ? files.map((slug) => photoUrl(code, slug)) : [];
}

module.exports = { photoUrl, portadaUrl, galleryUrls, PHOTO_FILES };
