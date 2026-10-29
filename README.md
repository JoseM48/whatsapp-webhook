# whatsapp-webhook
Webhook para recibir mensajes de WhatsApp

## Segundo número: TenGo Camello (2026-10-28)

`/webhook` enruta por `metadata.phone_number_id` (`lib/pilot/numero-entrante.js`):
`PHONE_NUMBER_ID` o sin metadata → Miu, igual que siempre;
`TENGOCAMELLO_PHONE_NUMBER_ID` → PMS `POST /api/tengocamello/whatsapp/inbound`
y la respuesta sale desde ese número; cualquier otro → se ignora con el log
`numero_desconocido_ignorado` (incluye el phone_number_id recibido).

**Llamadas: el número de TenGo Camello NO debe tener llamadas ni SIP activados**
hasta probarlo con una llamada real. Hoy sus eventos `calls` se ignoran y,
en el webhook de OpenAI, solo se rechaza una llamada cuyo `To` coincida con
`TENGOCAMELLO_DISPLAY_PHONE_NUMBER`; no está verificado que Meta mande ese
número en la cabecera `To`. Si el SIP del número apuntara al mismo proyecto
de OpenAI sin ese filtro, la llamada llegaría a Cami de Miu.

### Teo escribe desde el número de TenGo Camello

Teo encola con `POST /internal/desarrollos/tengocamello/mensaje` en el PMS
(migración 1052). Cada 20 s este webhook reclama esa cola
(`/api/tengocamello/whatsapp/outbox/reclamar`, firma HMAC de siempre), envía
cada texto con `sendWhatsAppTextFrom(TENGOCAMELLO_PHONE_NUMBER_ID, ...)` y
reporta el resultado. Nunca pasa por el outbox de Miu. Sin
`TENGOCAMELLO_PHONE_NUMBER_ID` el ciclo no corre.

### Número Demo compartido (beta de TenGo Camello)

`TENGOCAMELLO_DEMO_PHONE_NUMBER_ID` → PMS `POST /api/tengocamello/demo/inbound`
(migración 1060) y la respuesta sale desde el número demo. Cada negocio de la
beta tiene su enlace `wa.me/<número demo>?text=<CODIGO>`; el PMS liga el
teléfono del cliente con el negocio. Las respuestas de Teo a consultas del
demo salen por la cola `/api/tengocamello/demo/outbox/reclamar` (cada 20 s).
Sin la variable, el número demo se ignora (fail-closed); si coincide por error
con Miu o con el 7355, se ignora y esos caminos no cambian. Sus eventos
`calls` se ignoran: el número demo tampoco debe tener llamadas ni SIP; si se
activaran, agregar su número a `TENGOCAMELLO_DISPLAY_PHONE_NUMBER` (acepta
varios, separados por coma).
