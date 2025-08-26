// services/bookingAdapter.js
// HotelRunner adapter (robusto): disponibilidad, selección y reserva
// - Recorre iframes + intenta shadow DOM
// - Lee scripts application/json con estado inicial
// - Sniffea red incluso cuando el CT no es application/json
// - Genera artefactos de debug: debug-*.{html,png,buttons.txt,text.txt,frameN.txt,xhr.json,scripts.json}

const fs = require('fs');
const puppeteer = require('puppeteer');

const BOOKING_BASE_URL   = process.env.BOOKING_BASE_URL || 'https://la-frontera.hotelrunner.com/bv3/search';
const BOOKING_TIMEOUT_MS = parseInt(process.env.BOOKING_TIMEOUT_MS || '60000', 10);

function daysBetween(a, b) {
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000));
}
function nowTag() {
  const d = new Date(), p = (n) => String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildSearchUrl({ checkin, checkout, people = 2 }) {
  const url = new URL(BOOKING_BASE_URL);
  const payload = {
    checkin_date:  checkin,
    checkout_date: checkout,
    day_count:     daysBetween(checkin, checkout),
    room_count:    1,
    total_adult:   people,
    total_child:   0,
    rooms:        [{ adult_count: people, guest_count: people, child_count: 0, child_ages: [] }],
    guest_rooms:  { "0": { adult_count: people, guest_count: people, child_count: 0, child_ages: [] } }
  };
  url.searchParams.set('search', JSON.stringify(payload));
  return url.toString();
}

async function launchBrowser() {
  const headless = process.env.HEADLESS === '0' ? false : 'new';
  const slowMo   = process.env.SLOWMO ? parseInt(process.env.SLOWMO, 10) : 0;
  return puppeteer.launch({
    headless,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: { width: 1280, height: 900 },
    slowMo
  });
}

async function primePage(page) {
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = window.chrome || { runtime: {} };
  });
}

async function autoDismissOverlays(pageOrFrame) {
  await pageOrFrame.evaluate(() => {
    const hits = ['aceptar','acepto','entendido','cerrar','ok','de acuerdo','permitir','accept','agree','got it','close'];
    const btns = Array.from(document.querySelectorAll('button,[role="button"],a,.btn,.cookie,.cookies,.cc-allow'));
    for (const el of btns) {
      const t = (el.textContent || '').toLowerCase();
      if (hits.some(h => t.includes(h))) { try { el.click(); } catch(e) {} }
    }
    const ov = Array.from(document.querySelectorAll('[class*="cookie"],[id*="cookie"],.overlay,.modal,.backdrop'));
    for (const o of ov) { try { o.style.display = 'none'; } catch(e) {} }
  }).catch(()=>{});
}

async function gentleHydrationWaits(page) {
  // Esperas generosas para SPAs
  await page.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
}

function ctaRegex() {
  return /agregar habitaci[oó]n|añadir habitaci[oó]n|add room|reservar|seleccionar|continuar|proceder|ir al pago|continue|proceed/i;
}

async function framesArray(page) {
  try { return page.frames(); } catch { return [page.mainFrame?.() || page]; }
}

// Ejecuta función en TODAS las frames
async function evalFramesConcat(page, fn, arg) {
  const frames = await framesArray(page);
  const out = [];
  for (const fr of frames) {
    try {
      const v = await fr.evaluate(fn, arg);
      if (Array.isArray(v)) out.push(...v);
      else if (v) out.push(v);
    } catch {}
  }
  return out;
}

async function detectHasCtasAnyFrame(page) {
  const reSrc = ctaRegex().source;
  const hits = await evalFramesConcat(page, (reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const btns = Array.from(document.querySelectorAll('a,button'));
    if (btns.some(b => re.test((b.textContent || '').trim()))) return true;
    const txt = (document.body?.innerText || '').toLowerCase();
    return txt.includes('reservar') || txt.includes('seleccionar') || txt.includes('agregar habitación');
  }, reSrc);
  return hits.some(Boolean);
}

async function findNoRoomsAnyFrame(page) {
  const hits = await evalFramesConcat(page, () =>
    /no hay habitaciones disponibles|no rooms available|no availability/i.test(document.body?.innerText || ''), null
  );
  return hits.some(Boolean);
}

// -------- Buscador profundo: DOM + Shadow DOM --------
async function collectOptionsFromAllFrames(page) {
  const reSrc = ctaRegex().source;
  return await evalFramesConcat(page, (reSrc) => {
    const clean = (s='') => (s || '').replace(/\s+/g, ' ').trim();
    const toNumber = (s='') => { const m = s.replace(/\./g,'').match(/(\d[\d\s,\.]+)/); return m ? parseInt(m[1].replace(/[^\d]/g,''), 10) : null; };
    const re = new RegExp(reSrc, 'i');

    function* deepNodes(root) {
      const pushKids = (node) => {
        if (!node) return;
        if (node.nodeType === 1) yield node;
        // Shadow DOM
        const sr = node.shadowRoot || (node.attachShadow && node);
        if (sr && sr.children) for (const c of sr.children) yield* pushKids(c);
        // Hijos normales
        if (node.children) for (const c of node.children) yield* pushKids(c);
      };
      yield* pushKids(root || document);
    }

    const nodes = Array.from(deepNodes(document));
    const btns  = nodes.filter(n => n.matches?.('a,button') && re.test((n.textContent || '').trim()));
    const seen  = new Set();
    const res   = [];

    const isCard = (el) => el && el.matches?.('article, li, .card, .room, .hb-room, [class*="result"], [class*="room"], [class*="listing"]');

    for (const b of btns) {
      let node = b;
      for (let i=0; i<6 && node && !isCard(node); i++) node = node.parentElement;
      const card = isCard(node) ? node : b;

      const titleEl = card.querySelector?.('h3,h2,.title,.room-title,[class*="title"]');
      const title   = clean(titleEl?.textContent || b.textContent || '');
      if (!title) continue;

      const aptoMatch = title.match(/\b(\d{3,4})\b/);
      const apto = aptoMatch?.[1] || null;

      const priceEl = card.querySelector?.('.price,.amount,.total,.room-price,.rate,.tarifa,[class*="price"],[class*="amount"],[class*="total"],[class*="tarifa"]');
      const priceTx = clean(priceEl?.textContent || card.textContent || '');
      const currency = /USD/i.test(priceTx) ? 'USD' : 'COP';
      const from = toNumber(priceTx);

      const key = `${title}|${from||''}`;
      if (!seen.has(key)) { seen.add(key); res.push({ apto, title, from, currency }); }
    }

    // Si nada con CTA, al menos recoge títulos con número
    if (res.length === 0) {
      const titles = nodes.filter(n => n.matches?.('h2,h3,.title,.room-title,[class*="title"]'));
      for (const t of titles) {
        const text = clean(t.textContent || '');
        const m = text.match(/\b(\d{3,4})\b/);
        if (m) {
          const key = `${text}|`;
          if (!seen.has(key)) { seen.add(key); res.push({ apto: m[1], title: text, from: null, currency: 'COP' }); }
        }
      }
    }
    return res;
  }, reSrc);
}

// -------- Extrae posibles rooms desde scripts JSON incrustados --------
async function extractRoomsFromScriptsAnyFrame(page, tag) {
  const all = await evalFramesConcat(page, () => {
    const payloads = [];
    const pushJson = (txt) => {
      try {
        const json = JSON.parse(txt);
        payloads.push(json);
      } catch {}
    };

    // <script type="application/json">...</script>
    const scriptJson = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'));
    for (const s of scriptJson) pushJson(s.textContent || '');

    // Otros scripts: intentar localizar objetos grandes con "room" o "rooms"
    const scripts = Array.from(document.scripts || []);
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (!txt || txt.length < 50) continue;
      if (/"rooms?"|"room_name"|"rates?"|"inventory"/i.test(txt)) {
        // heurística: intenta parsear el primer {...} grande
        const i = txt.indexOf('{'); const j = txt.lastIndexOf('}');
        if (i >= 0 && j > i) {
          const maybe = txt.slice(i, j + 1);
          try { payloads.push(JSON.parse(maybe)); } catch {}
        }
      }
    }
    return payloads;
  });

  // Dump para diagnosticar
  try { fs.writeFileSync(`debug-${tag}.scripts.json`, JSON.stringify({ count: all.length }, null, 2)); } catch {}

  // Aplana y extrae
  function fromJson(payloads) {
    const results = [];
    const seen = new Set();
    function visit(o) {
      if (!o || typeof o !== 'object') return;
      const title = o.name || o.title || o.room_name || o.room || o.description || null;
      const price = o.price || o.amount || o.total || o.rate || o.nightly || o.daily || null;
      const currency = (typeof o.currency === 'string' && /usd|cop|\$|mxn|eur/i.test(o.currency)) ? (o.currency.toUpperCase()) : null;

      let pushable = false;
      let apto = null; let t = null; let from = null; let curr = null;

      if (title && typeof title === 'string') {
        t = String(title).trim();
        const m = t.match(/\b(\d{3,4})\b/);
        apto = m?.[1] || null;
        if (apto) pushable = true;
      }
      if (!pushable && price != null && typeof price === 'number') {
        from = Math.round(price);
        pushable = true;
      }
      if (currency) curr = currency.includes('USD') ? 'USD' : 'COP';

      if (pushable) {
        const key = `${t||''}|${from||''}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ apto, title: t || '', from: from || null, currency: curr || 'COP' });
        }
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') visit(v);
      }
    }
    for (const p of payloads) visit(p);
    return results;
  }

  return fromJson(all);
}

// ---------- Sniffer XHR (ampliado) ----------
function tryParseAnyJson(text) {
  try { return JSON.parse(text); } catch {}
  // Intenta localizar bloques JSON
  const i = text.indexOf('{'); const j = text.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(text.slice(i, j+1)); } catch {}
  }
  return null;
}

function extractRoomsFromJsonPayloads(payloads) {
  const results = [];
  const seen = new Set();
  function visit(o) {
    if (!o || typeof o !== 'object') return;
    const title = o.name || o.title || o.room_name || o.room || o.description || null;
    const price = o.price || o.amount || o.total || o.rate || o.nightly || o.daily || null;
    const currency = (typeof o.currency === 'string' && /usd|cop|\$|mxn|eur/i.test(o.currency)) ? (o.currency.toUpperCase()) : null;

    let pushable = false;
    let apto = null; let t = null; let from = null; let curr = null;

    if (title && typeof title === 'string') {
      t = String(title).trim();
      const m = t.match(/\b(\d{3,4})\b/);
      apto = m?.[1] || null;
      if (apto) pushable = true;
    }
    if (!pushable && price != null && typeof price === 'number') {
      from = Math.round(price);
      pushable = true;
    }
    if (currency) curr = currency.includes('USD') ? 'USD' : 'COP';

    if (pushable) {
      const key = `${t||''}|${from||''}`;
      if (!seen.has(key)) { seen.add(key); results.push({ apto, title: t || '', from: from || null, currency: curr || 'COP' }); }
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') visit(v);
    }
  }
  for (const p of payloads) visit(p);
  return results;
}

async function sniffNetwork(page, tag) {
  const payloads = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/search|avail|room|rate|price|inventory|result/i.test(url)) return;

      const ct = (res.headers()['content-type'] || '').toLowerCase();
      let data = null;

      if (ct.includes('application/json')) {
        data = await res.json().catch(()=>null);
      } else {
        // puede venir como text/javascript, text/html, etc.
        const txt = await res.text().catch(()=>null);
        if (txt) data = tryParseAnyJson(txt);
      }
      if (data) payloads.push({ url, data });
    } catch {}
  });

  return {
    getRaw: () => payloads,
    async dump() {
      try {
        const slim = payloads.slice(0, 10).map(p => ({ url: p.url, keys: Object.keys(p.data || {}) }));
        fs.writeFileSync(`debug-${tag}.xhr.json`, JSON.stringify({ count: payloads.length, index: slim }, null, 2));
      } catch {}
    }
  };
}

// ---------- Debug ----------
async function dumpDebug(page, tag) {
  try {
    await page.screenshot({ path: `debug-${tag}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`debug-${tag}.html`, html);

    const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('a,button')).map(b => (b.textContent || '').trim()).filter(Boolean).slice(0,200));
    fs.writeFileSync(`debug-${tag}.buttons.txt`, buttons.map((t,i)=>`${String(i+1).padStart(3,'0')}: ${t}`).join('\n'));
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 60000));
    fs.writeFileSync(`debug-${tag}.text.txt`, text);

    const frames = page.frames();
    for (let i = 0; i < Math.min(frames.length, 6); i++) {
      const fr = frames[i];
      try {
        const ftxt = await fr.evaluate(() => (document.body?.innerText || '').slice(0, 20000));
        fs.writeFileSync(`debug-${tag}.frame${i+1}.txt`, `URL: ${fr.url()}\n\n${ftxt}`);
      } catch {}
    }
    console.log('[booking] DEBUG guardado: debug-%s.*', tag);
  } catch (e) {
    console.log('[booking] no pude guardar debug:', e?.message || e);
  }
}

// =========== checkAvailability ===========
async function checkAvailability({ checkin, checkout, people = 2 }) {
  const search_url = buildSearchUrl({ checkin, checkout, people });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(BOOKING_TIMEOUT_MS);
  await primePage(page);

  const tag = nowTag();
  const sniffer = await sniffNetwork(page, tag);

  try {
    console.log('[booking] checkAvailability →', search_url);
    await page.goto(search_url, { waitUntil: 'domcontentloaded' });

    await autoDismissOverlays(page);
    for (const fr of await framesArray(page)) { await autoDismissOverlays(fr).catch(()=>{}); }

    await gentleHydrationWaits(page);

    await Promise.race([
      page.waitForFunction(() => /no hay habitaciones disponibles|no rooms available/i.test(document.body?.innerText || ''), { timeout: BOOKING_TIMEOUT_MS }).catch(() => {}),
      page.waitForFunction((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        return Array.from(document.querySelectorAll('a,button')).some(b => re.test((b.textContent || '').trim()));
      }, { timeout: BOOKING_TIMEOUT_MS }, ctaRegex().source).catch(() => {}),
      page.waitForNetworkIdle({ timeout: BOOKING_TIMEOUT_MS }).catch(() => {}),
      page.waitForTimeout(6000)
    ]);

    await dumpDebug(page, tag);
    await sniffer.dump();

    // 1) DOM (todas las frames, con Shadow DOM)
    const domOptions = await collectOptionsFromAllFrames(page);
    const hasCtas    = await detectHasCtasAnyFrame(page);
    const noRoomsTxt = await findNoRoomsAnyFrame(page);

    // 2) Scripts JSON embebidos
    const scriptOptions = await extractRoomsFromScriptsAnyFrame(page, tag);

    // 3) XHR/JSON
    const raw          = sniffer.getRaw();
    const jsonOptions  = extractRoomsFromJsonPayloads(raw.map(r => r.data));

    // Mezcla/dedup
    const allOptions = [...domOptions, ...scriptOptions, ...jsonOptions];
    const unique = [];
    const seen = new Set();
    for (const o of allOptions) {
      const key = `${o.title||''}|${o.from||''}`;
      if (!seen.has(key)) { seen.add(key); unique.push(o); }
    }

    const minFrom  = unique.reduce((acc, o) => (o.from && (!acc || o.from < acc)) ? o.from : acc, null);
    const currency = (unique.find(o => o.currency)?.currency) || 'COP';
    const nights   = daysBetween(checkin, checkout);
    const nightly_rate = minFrom || null;
    const total        = nightly_rate ? nightly_rate * nights : null;

    // Heurística de available:
    //  - si no aparece mensaje "no hay habitaciones"
    //  - y (hay opciones | hay CTAs | hubo XHR relevante)
    const available = !noRoomsTxt && (unique.length > 0 || hasCtas || raw.length > 0);

    await browser.close();
    return {
      available,
      nightly_rate,
      total,
      currency,
      room_name: unique[0]?.title || '',
      checkout_url: null,
      search_url,
      options: unique
    };
  } catch (err) {
    await browser.close();
    return {
      available: false,
      nightly_rate: null,
      total: null,
      currency: 'COP',
      room_name: '',
      checkout_url: null,
      search_url,
      options: []
    };
  }
}

// =========== selectAndCheckout ===========
async function selectAndCheckout({ checkin, checkout, people = 2, apto }) {
  if (!apto) throw new Error('apto_required');

  const search_url = buildSearchUrl({ checkin, checkout, people });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(BOOKING_TIMEOUT_MS);
  await primePage(page);

  try {
    console.log('[booking] selectAndCheckout →', search_url, 'apto:', apto);
    await page.goto(search_url, { waitUntil: 'domcontentloaded' });

    await autoDismissOverlays(page);
    for (const fr of await framesArray(page)) { await autoDismissOverlays(fr).catch(()=>{}); }

    await gentleHydrationWaits(page);

    const reSrc = ctaRegex().source;
    let clickedAdd = false;

    for (const fr of await framesArray(page)) {
      const ok = await fr.evaluate((needle, reSrc) => {
        const within = (el, text) => {
          let p = el;
          for (let i = 0; i < 6 && p; i++, p = p.parentElement) if ((p.textContent || '').includes(text)) return true;
          return false;
        };
        const re = new RegExp(reSrc, 'i');
        const btns = Array.from(document.querySelectorAll('button,[role="button"],a'));
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if (re.test(t) && within(b, String(needle))) { b.click(); return true; }
        }
        // Fallback: si hay link del apto, clic
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          if ((a.textContent || '').includes(String(needle))) { a.click(); return true; }
        }
        return false;
      }, String(apto), reSrc).catch(()=>false);
      if (ok) { clickedAdd = true; break; }
    }

    if (!clickedAdd) {
      await browser.close();
      return { ok: false, error: 'apto_not_found', search_url };
    }

    await Promise.race([
      page.waitForTimeout(1500),
      page.waitForNetworkIdle({ timeout: BOOKING_TIMEOUT_MS }).catch(() => {})
    ]);

    const nextLabels = ['Continuar','Seguir','Ir al pago','Proceder','Continue','Proceed'];
    let continued = false;
    for (const label of nextLabels) {
      for (const fr of await framesArray(page)) {
        const ok = await clickByText(fr, label).catch(()=>false);
        if (ok) { continued = true; break; }
      }
      if (continued) break;
    }
    if (!continued) await page.waitForTimeout(1200);

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: BOOKING_TIMEOUT_MS }).catch(() => {}),
      page.waitForTimeout(3000)
    ]);

    const checkout_url = page.url();
    await browser.close();
    return { ok: true, checkout_url, search_url };
  } catch (e) {
    await browser.close();
    return { ok: false, error: e?.message || 'select_error', search_url };
  }
}

// =========== createReservation ===========
async function createReservation({ checkout_url, name, lastname, country = 'Colombia', email, phone, payment_method = 'Transferencia' }) {
  if (!checkout_url) throw new Error('checkout_url_required');

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(BOOKING_TIMEOUT_MS);
  await primePage(page);

  try {
    await page.goto(checkout_url, { waitUntil: 'domcontentloaded' });
    await autoDismissOverlays(page);
    for (const fr of await framesArray(page)) { await autoDismissOverlays(fr).catch(()=>{}); }

    await tryType(page, ['input[name="first_name"]','input[name="Nombre"]','input[placeholder*="nombre" i]'], name);
    await tryType(page, ['input[name="last_name"]','input[name="Apellido"]','input[placeholder*="apellido" i]'], lastname);
    await trySelectCountry(page, country);
    await tryType(page, ['input[type="email"]','input[name="email"]','input[placeholder*="correo" i]'], email);
    await tryType(page, ['input[type="tel"]','input[name="phone"]','input[placeholder*="tel" i]'], phone);

    await clickByText(page, payment_method).catch(()=>{});
    await clickByText(page, 'reconozco que he leído').catch(()=>{});
    await clickByText(page, 'Términos y condiciones').catch(()=>{});
    await clickByText(page, 'Completar reserva').catch(()=>{});

    await page.waitForTimeout(2500);
    const confirmation_text = await page.evaluate(() => document.body.innerText || '');

    let reservation_id = null;
    const m = confirmation_text.match(/(reserva|confirmación)\s*[:#]\s*([A-Z0-9\-]+)/i);
    if (m) reservation_id = m[2];

    await browser.close();
    return { ok: true, reservation_id, confirmation_text };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// -------- utilidades DOM --------
async function tryType(pageOrFrame, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await pageOrFrame.$(sel);
      if (el) {
        await pageOrFrame.waitForSelector(sel, { timeout: 3000 }).catch(() => {});
        await pageOrFrame.click(sel, { clickCount: 3 }).catch(() => {});
        await pageOrFrame.type(sel, String(value)).catch(() => {});
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickByText(pageOrFrame, text) {
  const lower = String(text).toLowerCase();
  try {
    const clicked = await pageOrFrame.evaluate((needle) => {
      const nodes = Array.from(document.querySelectorAll('button,a,label,div,span,input[type="button"],input[type="submit"]'));
      const target = nodes.find(el => (el.textContent || el.value || '').toLowerCase().includes(needle));
      if (target) { target.click(); return true; }
      return false;
    }, lower);
    return !!clicked;
  } catch {
    return false;
  }
}

async function trySelectCountry(pageOrFrame, countryLabel) {
  const ok = await pageOrFrame.evaluate((wanted) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options || []);
      const found = opts.find(o => (o.textContent || '').trim().toLowerCase() === String(wanted).toLowerCase());
      if (found) {
        sel.value = found.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, countryLabel).catch(()=>false);
  if (ok) return true;

  await clickByText(pageOrFrame, 'País').catch(()=>{});
  await clickByText(pageOrFrame, countryLabel).catch(()=>{});
  return true;
}

// ===== Exports =====
module.exports = {
  checkAvailability,
  selectAndCheckout,
  createReservation,
  buildSearchUrl
};