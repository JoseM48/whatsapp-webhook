# Corpus D0 — conversaciones reales anonimizadas

Universo: 344 turnos comerciales / 100 casos en produccion (2026-08-26 a
2026-09-22).

## Exclusiones aplicadas antes de exportar

| Clase | Turnos | Casos | Motivo |
|---|---|---|---|
| Telefono de prueba (573146892662) | 128 | 44 | no es un huesped |
| Numero de bot automatico | 46 | 1 | asistente virtual de Claro capturado como lead |
| Control `[M0_UNSUPPORTED_INBOUND:*]` | 3 | 3 | mensaje de sistema, no del huesped |
| **Universo real** | **167** | **55** | 55 numeros distintos |

Jose Manuel no aparece en el corpus: su numero no genero ningun turno comercial
en la ventana.

## Anonimizacion

Se aplica EN SQL, contra la base: el texto crudo nunca sale de produccion sin
redactar. Reglas y resultado medido sobre los 167 turnos:

| Regla | Sustituto | Coincidencias |
|---|---|---|
| email | `<GUEST_EMAIL_n>` | 0 |
| 7 o mas digitos seguidos | `<GUEST_PHONE_n>` | 0 |
| `ddd ddd dddd` | `<GUEST_PHONE_n>` | 0 |

Verificacion adicional, sin coincidencias: documentos (cedula/pasaporte),
direcciones precisas, datos financieros (Nequi/Daviplata/cuenta/tarjeta),
identificadores sociales.

**Resultado: el corpus no contenia PII que redactar.** La capa de redaccion
queda puesta igual, porque el corpus crece.

### Dos errores propios, corregidos antes de usar el corpus

1. La primera regex de telefono, `\+?\d[\d \-]{6,}\d`, incluia el guion y por
   eso **destruyo 6 fechas** (`Del 2026-10-02, 3 meses, 2 personas.` ->
   `Del <GUEST_PHONE_1>, ...`). Era exactamente el dato a evaluar. Corregida a
   digitos consecutivos.
2. `Lea` se tokenizo como nombre propio. Mirando su contexto -- aparece sola,
   entre `No lees`, `No sabe leer`, `Vaya a escuela`, `Estudie` -- **es el verbo
   "lea", no un nombre**. Regla retirada.

De 64 palabras capitalizadas distintas en el corpus, ninguna es un nombre
propio de persona: son palabras comunes, meses, barrios (Poblado, Laureles,
Envigado) y marcas (Airbnb).

## Campos

  conv        ordinal estable de conversacion (no reidentificable)
  turno       orden dentro de la conversacion
  cuando      fecha/hora del turno, para resolver expresiones relativas
  texto       entrada del huesped, anonimizada
  accion      lo que el sistema decidio en su momento
  fallback    si aquel turno cayo al parser determinista
  l_*         interpretacion que produjo la ruta LEGACY -- BASELINE, no gold
