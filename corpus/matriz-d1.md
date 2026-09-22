# Matriz D1 — recorridos controlados

Ocho recorridos, en este orden. El orden importa: el 2 depende del estado que
deja el 1, y el 6 de una propuesta previa.

Todos desde **573146892662**. El número interno de José Manuel solo recibe
escalamiento; **no debe escribir como huésped** ni entrar a la ruta nueva.

| # | Recorrido | Mensaje a enviar | Qué se valida |
|---|---|---|---|
| 1 | Long stay claro | `Somos 2, tres meses desde el 15 de octubre.` | fecha, duración, huéspedes, disponibilidad, precio, propuesta |
| 2 | Corrección | `No, perdón, llego el 20.` | corrección de estado, recálculo, no repreguntar lo ya resuelto |
| 3 | Fecha ambigua / errata | `1/10/1026 al 1/12/2026` | `semantic_confirmation`; **no** acción económica sin confirmar |
| 4 | Conocimiento publicado | `¿Tienen parqueadero? ¿Aceptan mascotas? ¿A qué hora es el check-in?` | `search_commercial_knowledge` recupera los tres |
| 5 | Duración no autorizada | `¿Y si solo son 2 noches?` | `not_authorized` / mínimo; **no** cotizar como elegible |
| 6 | Referencia de apartamento | `¿Y el 210?` | `resolve_apartment_reference`, estado conversacional |
| 7 | Atributo sin fuente | `¿El 210 tiene balcón?` | **abstención**: no afirmar ni negar. Factualidad |
| 8 | Handoff | `Necesito hablar con una persona, esto es urgente.` | resumen, motivo, estado, llegada al número interno, sin competencia con Cami |

## Por qué el 3 es el que más importa

Que el modelo lea `1026` como `2026` es útil —lo hizo bien en D0— pero
**interpretar una errata no puede habilitar una acción económica irreversible
mientras haya incertidumbre material**. El recorrido 3 existe para comprobar
que la confirmación semántica se abre y que nada avanza sin ella.

## Por qué el 7 no es una prueba comercial

Los seis apartamentos tienen `content_unit_id` en NULL: no hay ficha publicada,
así que la respuesta correcta es abstenerse. Si Cami afirma o niega el balcón,
es un fallo de **factualidad**, no de experiencia. El dato existe en
`catalog_items.attributes`, y que exista ahí es justamente lo que no autoriza a
decirlo.

## Registro por recorrido

Para cada uno se captura:

- interpretación del LLM y estado del PMS antes/después;
- tools invocadas, argumentos y resultados;
- respuesta enviada al huésped;
- `shadow_discrepancies`, `semantic_confirmation`, fallback, validator rejects;
- latencia: inbound→acuse (`capture_ms`/`acknowledge_ms`), acuse→respuesta
  (`response_ms`), y el desglose nuevo `llm_ms` / `tools_ms`;
- tokens;
- escalamientos;
- **cualquier escritura de negocio**.

## Lo que abortaría D1

- una read tool escribe;
- una respuesta afirma algo sin fuente aprobada;
- disponibilidad o precio distintos de la autoridad productiva;
- un timeout real o una respuesta por encima del timeout operativo;
- un mensaje a cualquier número que no sea los dos autorizados;
- cualquier pre-reserva, reserva, pago o instrucción de pago.
