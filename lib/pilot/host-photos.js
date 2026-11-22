'use strict';

// CONFIANZA PRIMERO (José Manuel, 2026-11-22; DECISIONES_LOG "Confianza primero:
// presentación de José, reseñas y dirección; prueba A/B con Airbnb"). El primer
// mensaje a un lead nuevo empieza con la foto de José Manuel y su presentación.
// La foto vive aquí (public/anfitrion/, servida en /media/anfitrion) y NO en
// PHOTO_FILES: no es foto de un apartamento ni del edificio, así que nunca entra
// a una galería, a una portada ni a la lista que se compara con fotos-catalogo.js.
// El PMS manda la CLAVE (política confianza_v1.presentacion.foto_media_key, hoy
// "ANFITRION/jose"); cualquier otra clave devuelve null y no se envía.
// Cambiar el archivo exige subir HOST_PHOTO_VERSION (WhatsApp guarda por URL).
const HOST_PHOTOS = Object.freeze({ 'ANFITRION/jose': 'jose' });
const HOST_PHOTO_VERSION = '20261122';

function mediaBaseUrl() {
  return String(process.env.M0_CLOSED_PILOT_MEDIA_BASE_URL || 'https://whatsapp-webhook-erom.onrender.com')
    .replace(/\/$/, '');
}

// { code, url, host: true } o null.
function hostPhotoForKey(key) {
  const k = String(key || '');
  if (!Object.prototype.hasOwnProperty.call(HOST_PHOTOS, k)) return null;
  return { code: k, url: `${mediaBaseUrl()}/media/anfitrion/${HOST_PHOTOS[k]}.jpg?v=${HOST_PHOTO_VERSION}`, host: true };
}

module.exports = { HOST_PHOTOS, HOST_PHOTO_VERSION, hostPhotoForKey };
