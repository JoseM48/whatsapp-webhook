// services/bookingAdapter.js
// Adapter mínimo estable para validar carga y flujo end-to-end.
// Usa import('puppeteer') dinámico (ESM) pero NO automatiza aún el checkout.
// Luego volvemos a poner el adapter robusto.

const { URL } = require('url');

// Cargar Puppeteer (ESM) con import() desde CJS
let __puppeteerMod;
async function ensurePuppeteer() {
  if (!__puppeteerMod) {
    const mod = await import('puppeteer');
    __puppeteerMod = mod.default || mod;
  }
  return __puppeteerMod;
}

function daysBetween(a, b) {
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000));
}

function buildSearchUrl({ base = process.env.BOOKING_BASE_URL, checkin, checkout, people = 2 }) {
  const url = new URL(base || 'https://la-frontera.hotelrunner.com/bv3/search');
  const payload = {
    checkin_date: checkin,
    checkout_date: checkout,
    day_count: daysBetween(checkin, checkout),
    room_count: 1,
    total_adult: people,
    total_child: 0,
    rooms: [{ adult_count: people, guest_count: people, child_count: 0, child_ages: [] }],
    guest_rooms: { "0": { adult_count: people, guest_count: people, child_count: 0, child_ages: [] } }
  };
  url.searchParams.set('search', JSON.stringify(payload));
  return url.toString();
}

// ---- API esperada por index.js ----

async function checkAvailability({ checkin, checkout, people = 2 }) {
  // Validamos que puppeteer se pueda cargar (ESM ok)
  await ensurePuppeteer();
  const search_url = buildSearchUrl({ checkin, checkout, people });
  // Respuesta mínima (simulada) para probar el cableado
  const nights = daysBetween(checkin, checkout);
  const nightly_rate = null;
  const total = nightly_rate ? nightly_rate * nights : null;
  return {
    available: true,
    nightly_rate,
    total,
    currency: 'COP',
    room_name: '',
    checkout_url: null,
    search_url,
    options: []
  };
}

async function selectAndCheckout({ checkin, checkout, people = 2, apto }) {
  if (!apto) return { ok: false, error: 'apto_required', search_url: buildSearchUrl({ checkin, checkout, people }) };
  await ensurePuppeteer();
  const checkout_url = buildSearchUrl({ checkin, checkout, people });
  return { ok: true, checkout_url, search_url: checkout_url };
}

async function createReservation({ checkout_url, name, lastname, country = 'Colombia', email, phone, payment_method = 'Transferencia' }) {
  if (!checkout_url) throw new Error('checkout_url_required');
  await ensurePuppeteer();
  // Reserva simulada, para validar fin de flujo
  return {
    ok: true,
    reservation_id: `DEMO-${Date.now()}`,
    confirmation_text: 'Reserva simulada (adapter mínimo).'
  };
}

module.exports = {
  checkAvailability,
  selectAndCheckout,
  createReservation,
  buildSearchUrl
};
