'use strict';

const CONSENT_NOTICE = 'Al seleccionar CONTINUAR, autorizas a Mio La Frontera by Versadaa SAS a enviarte por WhatsApp mensajes necesarios para gestionar esta solicitud de alojamiento, incluyendo disponibilidad, pre-reserva, pago y reserva. No incluye publicidad. Puedes retirar la autorización escribiendo SALIR.';
const CONSENT_NOTICE_VERSION = 'LF_LEAD_TRANSACTIONAL_V1';
const CONSENT_NOTICE_HASH = '9052DC1C01D18A6371E378EAE82AA3D3E79528377593EB52346DD5908F503FDC';

function normalizeCommand(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function decideM0Response({ enabled, ingressMode, captured, deduplicated, newlyEnrolled, noticePending, text }) {
  if (!enabled || ingressMode !== 'controlled_cohort') return { handled: false, response: null };

  // Nunca derivar al Brain ni a los flujos heredados un contacto de la cohorte M0.
  if (!captured || (deduplicated && !noticePending)) return { handled: true, response: null };

  if (newlyEnrolled || noticePending) {
    return {
      handled: true,
      response: `${CONSENT_NOTICE}\n\nResponde CONTINUAR para autorizar y seguir, o SALIR para detener la atención automatizada.`,
      consentNoticeSubmissionRequired: true
    };
  }

  const command = normalizeCommand(text);
  if (command === 'CONTINUAR') {
    return {
      handled: true,
      response: 'Gracias. Para atenderte, indícanos fecha de entrada, fecha de salida, número de personas y apartamento si tienes preferencia. José Manuel supervisará esta conversación.'
    };
  }
  if (command === 'SALIR') {
    return {
      handled: true,
      response: 'Entendido. Detuvimos la atención automatizada. No enviaremos mensajes automáticos para esta solicitud.'
    };
  }

  // El resto lo atiende Jose Manuel manualmente durante M0.
  return { handled: true, response: null };
}

module.exports = { CONSENT_NOTICE, CONSENT_NOTICE_HASH, CONSENT_NOTICE_VERSION, decideM0Response, normalizeCommand };
