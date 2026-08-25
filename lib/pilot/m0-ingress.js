'use strict';

const CONSENT_NOTICE = 'Al seleccionar CONTINUAR, autorizas a Mio La Frontera by Versadaa SAS a enviarte por WhatsApp mensajes necesarios para gestionar esta solicitud de alojamiento, incluyendo disponibilidad, pre-reserva, pago y reserva. No incluye publicidad. Puedes retirar la autorización escribiendo SALIR.';
const CONSENT_NOTICE_VERSION = 'LF_LEAD_TRANSACTIONAL_V1';
const CONSENT_NOTICE_HASH = '9052DC1C01D18A6371E378EAE82AA3D3E79528377593EB52346DD5908F503FDC';
const FIXED_REQUEST_RECEIPT = 'Registramos tu solicitud. Iniciaremos la validación operativa de disponibilidad. Este mensaje no confirma disponibilidad, precio ni reserva. José Manuel supervisará esta conversación.';

function normalizeCommand(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function summarizeControlledRequest(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const apartment = text.match(/(?:lf[-\s]?)?(210|404|1208)\b/i)?.[1] || null;
  const rawPeople = text.match(/(?:somos|para)\s+(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d{1,2})(?:\s*(?:persona|personas))?/i)?.[1]?.toLowerCase() || null;
  const people = ({ uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10' })[rawPeople] || rawPeople;
  const dateRange = text.match(/(?:del\s+)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+(?:al|a)\s+(\d{1,2})(?:\s+de\s+([a-záéíóúñ]+))?/i);
  if (!apartment && !people && !dateRange) return null;
  const dates = dateRange
    ? `${dateRange[1]} de ${dateRange[2]} al ${dateRange[3]} de ${dateRange[4] || dateRange[2]}`
    : null;
  return { apartment: apartment ? `LF-${apartment}` : null, people, dates };
}

function controlledReceipt(summary) {
  const details = [
    summary?.apartment ? `apartamento ${summary.apartment}` : null,
    summary?.dates ? `fechas ${summary.dates}` : null,
    summary?.people ? `${summary.people} persona${summary.people === '1' ? '' : 's'}` : null
  ].filter(Boolean);
  const prefix = details.length ? `Registramos tu solicitud: ${details.join(', ')}.` : 'Registramos tu solicitud.';
  return `${prefix} Iniciaremos la validación operativa de disponibilidad. Este mensaje no confirma disponibilidad, precio ni reserva. José Manuel supervisará esta conversación.`;
}

function decideM0Response({ enabled, ingressMode, captured, deduplicated, newlyEnrolled, noticePending, consentActive, text }) {
  if (!enabled || ingressMode !== 'controlled_cohort') return { handled: false, response: null };

  // Nunca derivar al Brain ni a los flujos heredados un contacto de la cohorte M0.
  if (!captured || (deduplicated && !noticePending)) return { handled: true, response: null };

  if (newlyEnrolled || noticePending) {
    return {
      handled: true,
      response: `${CONSENT_NOTICE}\n\nResponde CONTINUAR para autorizar y seguir, o SALIR para detener la atención automatizada.`,
      responseKind: 'consent_notice',
      consentNoticeSubmissionRequired: true
    };
  }

  const command = normalizeCommand(text);
  if (command === 'CONTINUAR') {
    return {
      handled: true,
      response: 'Gracias. Para atenderte, indícanos fecha de entrada, fecha de salida, número de personas y apartamento si tienes preferencia. José Manuel supervisará esta conversación.',
      responseKind: 'continue_ack'
    };
  }
  if (command === 'SALIR') {
    return {
      handled: true,
      response: 'Entendido. Detuvimos la atención automatizada. No enviaremos mensajes automáticos para esta solicitud.',
      responseKind: 'opt_out_ack'
    };
  }

  if (consentActive !== true) {
    return {
      handled: true,
      response: 'Para continuar con esta solicitud responde CONTINUAR. Si prefieres detener la atención automatizada, responde SALIR.',
      responseKind: 'consent_reminder'
    };
  }

  // M0 no cotiza, no reserva ni confirma disponibilidad automáticamente. Sí
  // confirma la recepción para que una persona de la cohorte no quede sin
  // respuesta mientras José Manuel revisa la solicitud capturada.
  return {
    handled: true,
    response: FIXED_REQUEST_RECEIPT,
    responseKind: 'request_receipt'
  };
}

module.exports = {
  CONSENT_NOTICE, CONSENT_NOTICE_HASH, CONSENT_NOTICE_VERSION, FIXED_REQUEST_RECEIPT,
  decideM0Response, normalizeCommand, summarizeControlledRequest, controlledReceipt
};
