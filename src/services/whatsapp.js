// Sends one-time codes over WhatsApp using the Meta WhatsApp Cloud API.
// Meta only allows business-initiated messages through pre-approved templates,
// so create an "Authentication" template (e.g. "otp_code") in WhatsApp Manager.
import { config, providers } from '../config.js';
import { saveToOutbox } from './outbox.js';

export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? digits : '+' + digits;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export async function sendWhatsAppOtp(phone, code) {
  const text = `${code} is your ${config.appName} verification code. It expires in 10 minutes.`;
  if (!providers.whatsapp) return saveToOutbox({ channel: 'whatsapp', to: phone, text });
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone.replace('+', ''),
      type: 'template',
      template: {
        name: config.whatsapp.template,
        language: { code: config.whatsapp.lang },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // Authentication templates with a "copy code" button need the code here too.
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`);
  }
}
