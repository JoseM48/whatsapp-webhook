# Harness conversacional — Bloque A

Mide la arquitectura **actual** sobre un corpus de casos gold, sin tocar
producción, sin base de datos y sin llamar a ningún LLM.

    node harness/run-baseline.js

## Qué capa mide

`deterministicInterpret()` + `reconcileInterpretation()` de `lib/pilot/ai.js`.
Son funciones puras: mismo corpus, mismo resultado, coste cero.

**No** mide `mergeCommercialContext()` (vive en `pms-lite`). Las expectativas
que dependen de esa capa van en `expect_merge` y se declaran sin puntuarse:
atribuir a la extracción un fallo del merge inflaría el baseline.

## Categorías de expectativa

- `expect` — campos del schema, comparación estricta.
- `expect_merge` — estado acumulado; responsabilidad de `pms-lite`.
- estructurales (`needs_reference_resolution`, `should_trigger_confirmation`,
  `must_not_affirm`) — **no representables** en la arquitectura actual. No son
  fallos de extracción: son ausencias de diseño, y por eso se cuentan aparte.

## Medición con LLM

Deliberadamente **no** implementada en el Bloque A: cuesta dinero y envía texto
a un proveedor externo. Requiere autorización explícita.

## Privacidad

Ningún caso contiene texto literal de un huésped real, teléfono, nombre ni
correo. Los casos `real_documented` reproducen un patrón de fallo registrado en
documentación canónica, citando su fuente.
