# Llamada de emergencia a José — operación

Estado: construida el 2026-11-10 en la rama `feat/llamada-emergencia-jose`. **Sin desplegar. Apagada.**
Decisión: José Manuel aprobó construirla esta semana (2026-11-10). Encenderla requiere su OK.

## Qué hace

El PMS pide `POST /internal/voz/llamada-emergencia {clave, resumen}`. El webhook
llama a José desde el número de WhatsApp de Miu. Cami dice:

> José, habla Cami de Miu. Hay un caso urgente: <resumen>. Revisa tu WhatsApp interno.

Lo repite una vez y cuelga. No da más datos.

Ruta: OpenAI Live API (`POST /v1/live/sessions`, `transport.type = "sip"`) → troncal
SIP de Meta `sips:wa.meta.vc:5061` (digest) → WhatsApp de José.
Fuente: https://developers.openai.com/api/docs/guides/voice-sip (sección Live API, outbound).

Código: `lib/voz/llamada-saliente.js` (llamada y freno), `lib/voz/llamada-emergencia-ruta.js`
(firma HMAC), ruta en `index.js`. Pruebas: `test/llamada-emergencia.test.js`.

## Freno

- Máximo 2 intentos por `clave`, con al menos 3 min entre ellos (el iPhone deja pasar
  la segunda por "Llamadas repetidas" aunque esté en Concentración).
- Tope global por día de Colombia: `LLAMADA_EMERGENCIA_MAX_DIA` (3 por defecto, 3 como máximo).
- Tras 3 llamadas seguidas sin contestar no vuelve a llamar (`riesgo_revocacion`) hasta que
  José conteste una o se reinicie el servicio. Si el canal lateral no llega a funcionar, nunca
  se ve el "contestó" y el freno queda puesto: es a propósito.
- Un fallo también gasta el intento.
- Sin contestar, cuelga a los `LLAMADA_EMERGENCIA_TIMBRE_SEG` (60). Contestada, a los
  `LLAMADA_EMERGENCIA_HABLA_SEG` (45).
- Motivo: Meta revoca el permiso de llamada tras 4 llamadas seguidas sin contestar.
- El freno vive en memoria: un reinicio lo borra. El PMS debe deduplicar también.

## Variables de entorno (Render, `whatsapp-webhook`)

**El único cambio necesario en Render es `LLAMADA_EMERGENCIA_ON=1`** (con OK de José).
Lo demás sale de variables que el webhook ya tiene o de Meta en tiempo de ejecución:

| Dato | De dónde sale (en orden) |
|---|---|
| Clave SIP | `WA_SIP_PASSWORD`; si no está, `GET https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/settings?include_sip_credentials=true` con `ACCESS_TOKEN` → `calling.sip.servers[0].sip_user_password`. Caché en memoria 6 h; un `transport.failed` la borra. Nunca va a logs. |
| Usuario SIP y número que llama | `WA_SIP_USER` / `WA_SIP_CALLER_NUMBER`; si no están, `GET /{PHONE_NUMBER_ID}?fields=display_phone_number` → E.164 (con `+`). Caché 6 h. |
| Número de José | `JOSE_ALERT_PHONE`; si no está, `ADMIN_WA_NUMBER`. En este webhook `ADMIN_WA_NUMBER` es el teléfono del operador: el único que puede mandar "DETENER PILOTO M0" (`lib/pilot/m0-kill-switch-command.js`) y el que recibe `escalateToHuman`. El código no prueba que sea de José: lo confirma la llamada de prueba. El log de arranque dice `destino_fuente`. |

Opcionales: `WA_SIP_PROVIDER_URL` (`sips:wa.meta.vc:5061`), `LLAMADA_EMERGENCIA_MODELO`
(`gpt-live-1`), `LLAMADA_EMERGENCIA_MAX_DIA` (3, máximo 3), `LLAMADA_EMERGENCIA_GRAPH_BASE`.

Si Meta no responde o no trae la clave, no se llama y no se gasta el intento (`meta_sin_credencial`, 502).

Se reutilizan `VOZ_OPENAI_API_KEY`, `VOZ_OPENAI_VOZ` y `PMS_LITE_WEBHOOK_SECRET` (firma).

Firma de la ruta: `X-PMS-Signature = hex(HMAC-SHA256(PMS_LITE_WEBHOOK_SECRET, "llamada-emergencia.v1." + X-PMS-Timestamp + "." + cuerpo))`.
El prefijo evita reusar firmas de webhook -> PMS. Una firma repetida responde 409.

## Pasos únicos (en orden)

1. José da a Miu permiso **permanente** de llamarlo: Miu le manda la solicitud de
   permiso de llamada (o él llama primero al número de Miu) y José elige "Permitir siempre".
2. Hecho el 2026-11-10 (solo lectura, con OK de José): el número tiene calling `ENABLED`,
   SRTP `SDES` y servidor SIP `sip.miolafrontera.co:5061`. No cambiar la configuración SIP:
   las llamadas entrantes dependen de ella. La clave ya no se copia a ningún lado: el
   webhook la lee de Meta.
3. Desplegar el webhook. Comprobar en el log de arranque `[voz] llamada_emergencia`
   con `falta: []` y `destino_fuente`.

## Prueba (una sola llamada real)

1. Avisar a José la hora de la prueba.
2. Poner `LLAMADA_EMERGENCIA_ON=1`.
3. Pedir la llamada con la firma HMAC de esta ruta (clave `prueba:AAAAMMDD`, resumen `esto es una prueba`).
4. Revisar con José: sonó, se oyó el mensaje completo, colgó sola.
5. Revisar el log: `llamada_emergencia_iniciada`, `_timbrando`, `_contestada`, `_cerrada`.
6. Si falla, apagar y leer el error (`status`, `error_code`) antes de reintentar.
   No repetir más de 2 veces el mismo día (regla de Meta de 4 sin contestar).

## Revertir

- Inmediato: quitar `LLAMADA_EMERGENCIA_ON` en Render (la ruta vuelve a 404).
- Código: `git revert` del commit de esta rama sobre la punta desplegada.
- No hay credencial nueva guardada que borrar (vive solo en memoria). José puede quitar el
  permiso de llamada en su WhatsApp.

## Riesgos abiertos

- La guía de OpenAI dice que la Live API soporta salida por SIP, pero otra versión de la
  misma página decía que no. Se confirma solo con la prueba real.
- No está documentado si el modelo habla primero al contestar. Las instrucciones se lo
  piden y, al contestar, se manda `response.create` por el canal lateral (patrón de las
  entrantes; en la Live API no está documentado). Se valida en la prueba real.
- **Dominio del `From`:** el número tiene configurado el servidor SIP `sip.miolafrontera.co`.
  Meta puede exigir que el INVITE saliente venga de ese dominio; OpenAI pone su propio
  `From` y aquí no se controla. Si la prueba falla con 403/401 de Meta, es lo primero a revisar.
- Usuario digest: Meta pide que sea el número del negocio (el del `From`). Se manda en
  E.164 con `+`; si Meta lo rechaza, probar sin `+` con `WA_SIP_USER`.
- SRTP: OpenAI exige SDES-SRTP; el número ya lo tiene en SDES (verificado 2026-11-10).
- El freno vive en memoria y se borra al reiniciar.
