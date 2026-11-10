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
- Tope global por día de Colombia: `LLAMADA_EMERGENCIA_MAX_DIA` (4 por defecto).
- Un fallo también gasta el intento.
- Sin contestar, cuelga a los `LLAMADA_EMERGENCIA_TIMBRE_SEG` (60). Contestada, a los
  `LLAMADA_EMERGENCIA_HABLA_SEG` (45).
- Motivo: Meta revoca el permiso de llamada tras 4 llamadas seguidas sin contestar.
- El freno vive en memoria: un reinicio lo borra. El PMS debe deduplicar también.

## Variables de entorno (Render, `whatsapp-webhook`) — requieren OK de José

| Variable | Valor | Nota |
|---|---|---|
| `LLAMADA_EMERGENCIA_ON` | `1` | Interruptor. Sin él, la ruta responde 404. |
| `JOSE_ALERT_PHONE` | número de José, E.164 | Nunca en el código. |
| `WA_SIP_USER` | usuario SIP que da Meta | Normalmente el número del negocio de Miu. |
| `WA_SIP_PASSWORD` | clave SIP que da Meta | Secreta. |
| `WA_SIP_CALLER_NUMBER` | número de Miu, E.164 | Opcional si `WA_SIP_USER` ya es el número. |
| `WA_SIP_PROVIDER_URL` | `sips:wa.meta.vc:5061` | Opcional (es el valor por defecto). |
| `LLAMADA_EMERGENCIA_MODELO` | `gpt-live-1` | Opcional. |
| `LLAMADA_EMERGENCIA_MAX_DIA` | `4` | Opcional. |

Se reutilizan `VOZ_OPENAI_API_KEY`, `VOZ_OPENAI_VOZ` y `PMS_LITE_WEBHOOK_SECRET` (firma).

## Pasos únicos (en orden)

1. José da a Miu permiso **permanente** de llamarlo: Miu le manda la solicitud de
   permiso de llamada (o él llama primero al número de Miu) y José elige "Permitir siempre".
2. Con OK de José, Teo lee la credencial SIP del número de Miu en Meta:
   `GET /{phone_number_id}/settings?include_sip_credentials=true`. Solo lectura.
   No cambiar la configuración SIP del número: las llamadas entrantes dependen de ella.
3. Revisar en Meta que el número tenga SRTP activo (SDES). OpenAI lo exige en saliente.
4. Con OK de José, Teo guarda en Render las variables de la tabla, sin `LLAMADA_EMERGENCIA_ON`.
5. Desplegar el webhook. Comprobar en el log de arranque `[voz] llamada_emergencia`
   con `falta: []`.

## Prueba (una sola llamada real)

1. Avisar a José la hora de la prueba.
2. Poner `LLAMADA_EMERGENCIA_ON=1`.
3. Pedir la llamada con firma HMAC (clave `prueba:AAAAMMDD`, resumen `esto es una prueba`).
4. Revisar con José: sonó, se oyó el mensaje completo, colgó sola.
5. Revisar el log: `llamada_emergencia_iniciada`, `_timbrando`, `_contestada`, `_cerrada`.
6. Si falla, apagar y leer el error (`status`, `error_code`) antes de reintentar.
   No repetir más de 2 veces el mismo día (regla de Meta de 4 sin contestar).

## Revertir

- Inmediato: quitar `LLAMADA_EMERGENCIA_ON` en Render (la ruta vuelve a 404).
- Código: `git revert` del commit de esta rama sobre la punta desplegada.
- Credencial: borrar `WA_SIP_PASSWORD` de Render. José puede quitar el permiso de llamada
  en su WhatsApp.

## Riesgos abiertos

- La guía de OpenAI dice que la Live API soporta salida por SIP, pero otra versión de la
  misma página decía que no. Se confirma solo con la prueba real.
- No está documentado si el modelo habla primero al contestar. Las instrucciones se lo
  piden. Si no habla, falta un evento por el canal lateral (no documentado hoy).
- Meta puede exigir que el `From` coincida con el servidor SIP configurado para el número.
  OpenAI pone el `From`; no se puede controlar desde aquí.
- SRTP: OpenAI exige SDES-SRTP. Meta usa DTLS-SRTP en WebRTC; en SIP se configura en sus
  ajustes. Verificar antes de la prueba.
- El freno vive en memoria y se borra al reiniciar.
