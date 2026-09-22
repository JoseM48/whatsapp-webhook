const r = require('./resultados-d0.json');
const corpus = require('./corpus-d0.json');
const norm = (v) => (v === undefined || v === '' ? null : v);

// El campo `l_*` de legacy es el contexto ACUMULADO tras el turno. La salida
// del LLM es lo que dice ESE mensaje. Compararlos directamente cuenta como
// desacuerdo cada "Gracias" que no repite los datos anteriores.
//
// Para comparar lo mismo con lo mismo, se fusiona la extraccion del LLM sobre
// el contexto previo -- que es exactamente lo que hace mergeCommercialContext
// en el PMS -- y se compara el estado resultante contra el estado de legacy.
const previo = new Map();
for (const t of corpus) {
  const k = t.conv + '/' + (t.turno - 1);
  previo.set(t.conv + '/' + t.turno, previo.has(k) ? previo.get(k) : null);
}
const legacyPrevio = (conv, turno) => {
  const p = corpus.find((t) => t.conv === conv && t.turno === turno - 1);
  return p ? { check_in: p.l_check_in, status: p.l_status,
    nights: p.l_nights ? Number(p.l_nights) : null,
    guests: p.l_guests ? Number(p.l_guests) : null,
    apt: p.l_apt, lang: p.l_lang } : {};
};

const CAMPOS = ['check_in', 'status', 'nights', 'guests', 'apt', 'lang'];
let iguales = 0; const difiere = [];
for (const x of r) {
  const base = legacyPrevio(x.conv, x.turno);
  const fusion = {};
  for (const c of CAMPOS) {
    const nuevo = norm(x.llm?.[c]);
    // `status` y `lang` siempre los fija el turno; el resto solo si aporta.
    fusion[c] = (c === 'status' || c === 'lang') ? nuevo : (nuevo ?? norm(base[c]) ?? null);
  }
  const d = CAMPOS.filter((c) => String(norm(x.legacy[c])) !== String(norm(fusion[c])));
  if (!d.length) iguales += 1; else difiere.push({ x, campos: d, fusion });
}

console.log('=== ACUERDO, comparando ESTADO contra ESTADO ===');
console.log('identicos :', iguales, '(' + (100 * iguales / r.length).toFixed(1) + '%)');
console.log('difieren  :', difiere.length, '(' + (100 * difiere.length / r.length).toFixed(1) + '%)');
console.log('\n=== DESACUERDO POR CAMPO ===');
for (const c of CAMPOS) {
  const n = difiere.filter((d) => d.campos.includes(c)).length;
  console.log(`  ${c.padEnd(10)} ${String(n).padStart(3)}`);
}
require('fs').writeFileSync('revision-manual.json', JSON.stringify(difiere.map(({ x, campos, fusion }) => ({
  conv: x.conv, turno: x.turno, texto: x.texto, campos,
  legacy: { check_in: x.legacy.check_in, status: x.legacy.status, nights: x.legacy.nights,
    guests: x.legacy.guests, apt: x.legacy.apt, lang: x.legacy.lang, accion: x.legacy.accion },
  llm: fusion, tools: x.tools.map((t) => t.tool + ':' + t.status)
})), null, 1));
console.log('\n->', difiere.length, 'casos para revision manual');
