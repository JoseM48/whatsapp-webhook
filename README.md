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
