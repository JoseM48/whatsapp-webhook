const r = require('./resultados-d0.json');
const CAMPOS = ['check_in', 'status', 'nights', 'guests', 'apt', 'lang'];
const norm = (v) => (v === undefined || v === '' ? null : v);

let iguales = 0; const difiere = [];
for (const x of r) {
  const d = CAMPOS.filter((c) => String(norm(x.legacy[c])) !== String(norm(x.llm?.[c])));
  if (d.length === 0) iguales += 1; else difiere.push({ x, campos: d });
}
console.log('=== ACUERDO LEGACY vs LLM (6 campos de interpretacion) ===');
console.log('identicos en los 6 campos :', iguales, '(' + (100 * iguales / r.length).toFixed(1) + '%)');
console.log('difieren en >=1 campo     :', difiere.length, '(' + (100 * difiere.length / r.length).toFixed(1) + '%)');

console.log('\n=== DESACUERDO POR CAMPO ===');
for (const c of CAMPOS) {
  const n = r.filter((x) => String(norm(x.legacy[c])) !== String(norm(x.llm?.[c]))).length;
  console.log(`  ${c.padEnd(10)} ${String(n).padStart(3)}  (${(100 * n / r.length).toFixed(1)}%)`);
}

console.log('\n=== DIRECCION DEL DESACUERDO EN FECHA (check_in) ===');
const f = { ambos: 0, soloLlm: 0, soloLegacy: 0, distintas: 0 };
for (const x of r) {
  const a = norm(x.legacy.check_in), b = norm(x.llm?.check_in);
  if (!a && !b) continue;
  if (a && b && a === b) f.ambos += 1;
  else if (!a && b) f.soloLlm += 1;
  else if (a && !b) f.soloLegacy += 1;
  else f.distintas += 1;
}
console.log('  la misma fecha            :', f.ambos);
console.log('  SOLO el LLM la resuelve   :', f.soloLlm);
console.log('  SOLO legacy la resuelve   :', f.soloLegacy);
console.log('  ambos resuelven, distinta :', f.distintas);

console.log('\n=== TOOLS ===');
const tools = {};
for (const x of r) for (const t of x.tools) {
  tools[t.tool] = tools[t.tool] || {};
  tools[t.tool][t.status] = (tools[t.tool][t.status] || 0) + 1;
}
for (const [t, s] of Object.entries(tools)) console.log(' ', t.padEnd(32), JSON.stringify(s));

console.log('\n=== MOTIVOS DE needs_clarification EN TOOLS ===');
const motivos = {};
for (const x of r) for (const t of x.tools) if (t.reason) motivos[t.reason] = (motivos[t.reason] || 0) + 1;
for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(' ', String(n).padStart(3), m);

console.log('\n=== CONFIRMACION SEMANTICA ===');
console.log('  turnos que abren confirmacion:', r.filter((x) => x.confirmation).length);

console.log('\n=== AMBIGUEDAD DECLARADA POR EL LLM ===');
const amb = {};
for (const x of r) for (const a of (x.ambiguity || [])) amb[a.field] = (amb[a.field] || 0) + 1;
console.log(' ', JSON.stringify(amb));

console.log('\n=== FALLBACK ===');
console.log('  LLM   :', r.filter((x) => !x.ok).length);
console.log('  legacy (en su momento):', r.filter((x) => x.legacy.fallback).length);

require('fs').writeFileSync('revision-manual.json', JSON.stringify(difiere.map(({ x, campos }) => ({
  conv: x.conv, turno: x.turno, texto: x.texto, campos,
  legacy: x.legacy, llm: x.llm, tools: x.tools.map((t) => t.tool + ':' + t.status)
})), null, 1));
console.log('\n->', difiere.length, 'casos escritos en revision-manual.json');
