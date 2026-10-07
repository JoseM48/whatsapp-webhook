'use strict';

// GUIA DEL HUESPED, AJUSTES (José Manuel, 2026-10-07; DECISIONES_LOG "Guía del
// huésped, ajustes", punto 1). Cami puede decir "al confirmar tu reserva te
// enviamos una guía del sector", solo si el paquete lo trae (FAQ
// `guia_del_sector`, que el PMS publica con la política encendida), en un
// momento natural y una sola vez. El validador del PMS rechaza la promesa sin
// respaldo en el paquete.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

test('la regla de la guía: solo con el tema en el paquete, en un momento natural y una sola vez', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /GUEST GUIDE \(decision 2026-10-07\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /topic "guia_del_sector"/);
  assert.match(WRITER_SYSTEM_PROMPT, /al confirmar tu reserva te enviamos una guía del sector/);
  assert.match(WRITER_SYSTEM_PROMPT, /at most once in the conversation/);
  assert.match(WRITER_SYSTEM_PROMPT, /Without that topic in the packet, do not mention any guide/);
});

test('el redactor ve la frase publicada tal cual', () => {
  const texto = 'Al confirmar tu reserva te enviamos una guía del sector con lugares cercanos, cómo moverte y datos útiles.';
  const view = writerViewOfPacket({ general_knowledge: [{ topic: 'guia_del_sector', text: texto }] });
  assert.deepEqual(view.general_knowledge, [{ topic: 'guia_del_sector', text: texto }]);
});
