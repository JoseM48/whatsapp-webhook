# Examen de Cami (banco de oro)

Paquete 3 del rediseño de comunicaciones y escalamientos ("se equivoca menos"; GO de José
Manuel, 2026-11-11, `DECISIONES_LOG.md`). Cumple la decisión del 2026-11-10: "examen fijo con
conversaciones reales antes de cada cambio".

## Qué es

- `banco-oro.json`: 91 casos reales anonimizados (sin teléfonos, documentos, correos ni
  apellidos). 72 son turnos de Cami (`capa: "cami"`), con la conversación anterior, el mensaje,
  la interpretación y el paquete que el PMS armó ese día, más una foto del conocimiento publicado
  (`conocimiento`). 19 son de la cadena (`capa: "cadena"`, mini Teo y Teo de guardia): una firma
  de `cami_errores` por caso; esos los corre el examen del banco del PMS (migración 1280).
- Cubre las firmas de `cami_errores` al 2026-11-11 (la repetida `no_sabia:other` con sus 12
  turnos reales), Walter (lead 368), Juan (lead 192), Astrid (lead 359), Nick (lead 285), los
  bucles de confirmación de fechas (lead 357), "Por mes" repetido (lead 295), "Hola Claro"
  (patrón reportado, sin fila en BD) y una muestra amplia (una acción distinta por caso).
- Cada caso declara afirmaciones (`afirmaciones.js`): comunes (no inventa cifras, no repite el
  último mensaje, no habla de la mecánica interna) y propias (dice "al mes" o "en total", no
  promete confirmar lo que no hace falta, no propone un día que la persona no dijo, etc.).
  Un caso con `pendiente` documenta un error que el redactor no puede arreglar porque la
  decisión es del PMS; se reporta y no frena la compuerta.

## Cómo se corre

```
npm run examen:cami                 # grabado: sin red ni costo. Es la compuerta.
npm run examen:cami:real            # califica lo que Cami respondió de verdad en producción ("antes")
EXAMEN_PMS_DIR=<checkout del PMS> EXAMEN_ENV_FILE=<.env con OPENAI_API_KEY> \
  npm run examen:cami:vivo -- --tope-usd 5    # modelo real con tope de gasto; graba las respuestas
```

Opciones: `--casos E5794,E5795`, `--grupo walter`, `--version "texto"`, `--salida ruta.json`.
El informe queda en `examen/out/` (no se versiona).

- **Grabado** repite las respuestas del modelo y los veredictos del validador del PMS guardados
  en `grabaciones/` (una por caso, por huella de prompt + entrada). Si cambia el prompt del
  redactor, la vista del paquete o el caso, la huella cambia y el caso sale `sin_grabacion`: la
  compuerta no pasa hasta correr en vivo y grabar.
- **Vivo** usa el mismo modelo de producción (`NEW_LLM_CONVERSATIONAL_MODEL`, por defecto
  `gpt-5.6-luna`) y, con `EXAMEN_PMS_DIR`, el validador real del PMS. El tope corta antes de
  gastar de más (precios configurables: `EXAMEN_USD_MTOK_ENTRADA`, `EXAMEN_USD_MTOK_SALIDA`;
  por defecto 2,5 y 15 USD por millón, conservadores). Una corrida completa cuesta unos 3 USD
  estimados.

## Compuerta antes de cada push que toque a Cami

Toca a Cami: `lib/pilot/llm/writer.js`, `conversational-engine.js`, `interpretation-*`,
`lib/pilot/anti-repeticion.js`, `lib/voz/cami-voz.js`, y en el PMS el paquete
(`m0-closed-pilot.service.js`), el validador (`m0-response-validator.js`) o el conocimiento.

1. `npm test` en verde (salvo las fallas conocidas de entorno).
2. `npm run examen:cami`. Si sale `sin_grabacion` (cambió el prompt): correr el modo vivo con
   `--grabar` y revisar el informe.
3. Compuerta `PASA` = ningún caso no pendiente falla. Si un caso falla, se corrige antes de
   desplegar o se marca `pendiente` con su motivo (nunca se borra el caso).
4. Las grabaciones nuevas van en el mismo commit que el cambio.
5. José despliega. Después de desplegar: `node examen/aplicar-errores.js` (ver abajo).

## Errores de Cami: marcar lo corregido

`errores-plan.json` dice, por cada fila de `cami_errores`, si quedó corregida (con la lección),
si estaba mal clasificada (falla técnica del mini Teo, firma genérica `other`) o por qué sigue
abierta. Se aplica por el flujo de calidad que ya existe (PATCH
`/internal/desarrollos/calidad/errores/:id`), solo después del despliegue:

```
PMS_URL=https://<pms> PMS_TOKEN_FILE=<token de Desarrollos> node examen/aplicar-errores.js            # muestra
PMS_URL=https://<pms> PMS_TOKEN_FILE=<token de Desarrollos> node examen/aplicar-errores.js --aplicar  # aplica
```

## Cómo se armó el banco

`construir-banco.mjs` (con `EXAMEN_PMS_DIR` para usar `redactPii` del PMS y `EXAMEN_RAW_DIR`
con las extracciones). Las extracciones son de solo lectura en la BD de producción:
`m0_closed_pilot_events` (`COMMERCIAL_INBOUND`, `authorized_response_packet`,
`payload_json->'interpretation'`), `interacciones` (mensaje y conversación anterior),
`m0_closed_pilot_outbox` (lo que salió), `cami_errores`, `mini_teo_acciones`,
`teo_guardia_acciones`, `content_units`/`content_versions` y `commercial_policies`. Los
archivos crudos no se versionan.
