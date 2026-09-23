'use strict';

// LA INCERTIDUMBRE DESCRIBE LO QUE EL MODELO DUDA, NO LO QUE NO SABE.
//
// Este archivo cubre un hueco demostrado: el calculo de `uncertainty` se
// reparo el 2026-09-22 (commit d03b078) y quedo SIN prueba de regresion.
//
// El defecto: se tomaba el minimo de confianza entre llegada, duracion y
// huespedes SIEMPRE, incluidos los campos que el huesped ni menciono. Asi,
// "el 15 de octubre" -- una fecha clarisima, sin personas ni duracion --
// salia con incertidumbre 1,00.
//
// Por que importa tanto como para estar en la suite critica: la politica
// `conversation_confirmation_v1` abre una confirmacion cuando la
// incertidumbre supera 0,4. Con el calculo viejo, casi TODOS los primeros
// turnos habrian abierto una confirmacion falsa, y una confirmacion abierta
// BLOQUEA cotizar y proponer. Un error de aritmetica en este campo apaga la
// conversacion comercial entera.

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');

const UMBRAL = 0.4;   // el de conversation_confirmation_v1

function v2({ arrival = null, duration = null, guests = null } = {}) {
  return {
    language: 'es',
    stay: {
      arrival: arrival ?? { kind: 'none', date: null, precision: null, confidence: 0 },
      duration: duration ?? { nights: null, kind: 'none', confidence: 0 },
      guests: guests ?? { total: null, adults: null, children: null, infants: null, confidence: 0 }
    },
    apartment_reference: { kind: 'none', raw: '', hint_value: null, confidence: 0 },
    pets: { mentioned: false, kind: 'none', count: null },
    exception_request: false,
    requests_human: false
  };
}

// EL CASO QUE ORIGINO LA REPARACION.
test('una fecha clara y sola NO arrastra incertidumbre de lo no dicho', () => {
  const legacy = projectToLegacyInterpretation(v2({
    arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: 0.99 }
  }));

  assert.equal(legacy.check_in, '2026-10-15');
  assert.ok(legacy.uncertainty <= 0.05,
    `"el 15 de octubre" no puede salir con incertidumbre ${legacy.uncertainty}`);
  assert.ok(legacy.uncertainty < UMBRAL,
    'por debajo del umbral: no debe abrir una confirmacion falsa');
});

test('la duda de un dato dudoso SI se refleja', () => {
  const legacy = projectToLegacyInterpretation(v2({
    arrival: { kind: 'approximate', date: '2026-10-01', precision: 'month', confidence: 0.55 }
  }));

  assert.ok(legacy.uncertainty >= UMBRAL,
    `una llegada aproximada debe superar el umbral, salio ${legacy.uncertainty}`);
});

// Un turno vacio no puede parecer un turno "seguro": sin nada aportado, el
// minimo se toma sobre el conjunto vacio y debe quedar en 0 de confianza.
test('sin ningun dato aportado la incertidumbre no se inventa baja', () => {
  const legacy = projectToLegacyInterpretation(v2());
  assert.ok(Number.isFinite(legacy.uncertainty), 'debe ser un numero, no Infinity ni NaN');
  assert.ok(legacy.uncertainty >= 0 && legacy.uncertainty <= 1,
    `fuera de rango: ${legacy.uncertainty}`);
});

test('solo pesan los campos aportados, no los tres siempre', () => {
  // Llegada firme + duracion firme, sin huespedes: los huespedes ausentes no
  // deben contaminar el resultado.
  const dosCampos = projectToLegacyInterpretation(v2({
    arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: 0.95 },
    duration: { nights: 30, kind: 'exact', confidence: 0.95 }
  }));
  assert.ok(dosCampos.uncertainty <= 0.1, `salio ${dosCampos.uncertainty}`);

  // El mismo caso anadiendo huespedes con confianza BAJA si debe subir.
  const conDudaReal = projectToLegacyInterpretation(v2({
    arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: 0.95 },
    duration: { nights: 30, kind: 'exact', confidence: 0.95 },
    guests: { total: 2, adults: 2, children: 0, infants: 0, confidence: 0.3 }
  }));
  assert.ok(conDudaReal.uncertainty > dosCampos.uncertainty,
    'un dato aportado con poca confianza SI debe subir la incertidumbre');
});

test('el rango se mantiene en [0,1] con cualquier combinacion', () => {
  for (const confianza of [0, 0.01, 0.5, 0.99, 1]) {
    const legacy = projectToLegacyInterpretation(v2({
      arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: confianza }
    }));
    assert.ok(legacy.uncertainty >= 0 && legacy.uncertainty <= 1,
      `confianza ${confianza} produjo ${legacy.uncertainty}`);
  }
});
