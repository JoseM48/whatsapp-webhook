#!/usr/bin/env node
'use strict';

// Aplica examen/errores-plan.json a cami_errores por el flujo de calidad que ya existe
// (PATCH /internal/desarrollos/calidad/errores/:id: corregido_nota = qué se corrigió y la lección;
// firma y categoría cuando estaban mal clasificadas). Se corre DESPUÉS de desplegar el PMS y el
// webhook con los arreglos (si no, "corregido" sería falso). Por defecto solo muestra el plan.
//
//   PMS_URL=https://... PMS_TOKEN_FILE=<ruta del token de Desarrollos> node examen/aplicar-errores.js [--aplicar]
//
// El token nunca se imprime. Antes de aplicar lee cada error y no toca uno que ya esté corregido.

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'errores-plan.json'), 'utf8'));
  const base = process.env.PMS_URL;
  const token = process.env.PMS_TOKEN_FILE ? fs.readFileSync(process.env.PMS_TOKEN_FILE, 'utf8').trim() : process.env.PMS_TOKEN;
  for (const e of plan.errores) {
    const cuerpo = {};
    if (e.corregido_nota) cuerpo.corregido_nota = e.corregido_nota;
    if (e.firma) cuerpo.firma = e.firma;
    if (e.categoria) cuerpo.categoria = e.categoria;
    console.log(`${aplicar ? 'APLICA' : 'plan'} error ${e.id} [${e.estado}] ${JSON.stringify(cuerpo)}${e.motivo ? ` -- ${e.motivo}` : ''}`);
    if (!aplicar || !Object.keys(cuerpo).length) continue;
    if (!base || !token) throw new Error('faltan PMS_URL y PMS_TOKEN_FILE (o PMS_TOKEN)');
    const h = { Authorization: `Bearer ${token}` };
    const lista = (await axios.get(`${base}/internal/desarrollos/calidad/errores`, { headers: h, params: { limite: 500 } })).data?.data || [];
    const actual = lista.find((x) => Number(x.id) === Number(e.id));
    if (!actual) { console.log(`  no existe ${e.id}: se omite`); continue; }
    if (actual.corregido_at && cuerpo.corregido_nota) delete cuerpo.corregido_nota;
    if (!Object.keys(cuerpo).length) { console.log('  ya estaba corregido'); continue; }
    await axios.patch(`${base}/internal/desarrollos/calidad/errores/${e.id}`, cuerpo, { headers: h });
  }
}

main().catch((e) => { console.error('[aplicar-errores] fallo', e?.response?.status || '', e?.message || e); process.exitCode = 1; });
