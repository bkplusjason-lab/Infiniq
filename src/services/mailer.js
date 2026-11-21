import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { saveToOutbox } from './outbox.js';

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d2433">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#3b4cca;color:#fff;padding:20px 28px;font-size:20px;font-weight:700">${esc(config.appName)}</td></tr>
    <tr><td style="padding:28px">
      <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 28px;background:#fafbfc;color:#6b7280;font-size:12px">
      You are receiving this email because an account was used at ${esc(config.appUrl)}.
      If this wasn't you, you can ignore this message.
    </td></tr>
  </table></td></tr></table></body></html>`;
}

export async function sendMail({ to, subject, text, html }) {
  if (!to) return;
  if (!transport) return saveToOutbox({ channel: 'email', to, subject, text, html });
  await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
}

export function sendWelcomeEmail(user) {
  const name = user.name || 'there';
  const subject = `Welcome to ${config.appName}`;
  const text = `Hi ${name},

Thank you for registering with ${config.appName}. Your account is now active.

With ${config.appName} you can record sermons, lectures and meetings, get a transcript that separates the different speakers, and keep organised notes and minutes in one place.

For your security, every time you sign in we will send you a 6-digit one-time code. Never share this code with anyone; our team will never ask you for it.

Get started: ${config.appUrl}

Warm regards,
The ${config.appName} team`;
  const html = layout(`Welcome, ${name}!`, `
    <p>Thank you for registering with <b>${esc(config.appName)}</b>. Your account is now active.</p>
    <p>You can record sermons, lectures and meetings, get a transcript that separates the different speakers, and keep organised notes and minutes in one place.</p>
    <p><b>Your security:</b> every time you sign in we will send you a 6-digit one-time code. Never share this code with anyone; our team will never ask you for it.</p>
    <p style="margin:28px 0"><a href="${esc(config.appUrl)}" style="background:#3b4cca;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Open ${esc(config.appName)}</a></p>
    <p>Warm regards,<br>The ${esc(config.appName)} team</p>`);
  return sendMail({ to: user.email, subject, text, html });
}

export function sendOtpEmail(email, code) {
  const subject = `${code} is your ${config.appName} sign-in code`;
  const text = `Your ${config.appName} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not try to sign in, ignore this email.`;
  const html = layout('Your sign-in code', `
    <p>Enter this code on the website to finish signing in:</p>
    <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:20px 0">${esc(code)}</p>
    <p>It expires in 10 minutes. If you did not try to sign in, you can ignore this email.</p>`);
  return sendMail({ to: email, subject, text, html });
}

export function sendRetentionWarning(user, items) {
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const lines = items.map((i) => `- "${i.title}": ${i.what === 'audio' ? 'audio' : 'recording, transcript and notes'} will be deleted on ${fmt(i.at)}`);
  const subject = `Some of your ${config.appName} recordings will be deleted soon`;
  const text = `Hi ${user.name || 'there'},

Your plan keeps data for a limited time. The following will be deleted soon:

${lines.join('\n')}

To keep them longer, upgrade your plan: ${config.appUrl}/#/plans
You can also download them now from each recording's Export menu.

The ${config.appName} team`;
  const html = layout('Some recordings will be deleted soon', `
    <p>Your plan keeps data for a limited time. The following will be deleted soon:</p>
    <ul>${items.map((i) => `<li><b>${esc(i.title)}</b>: ${i.what === 'audio' ? 'audio' : 'recording, transcript and notes'} on ${esc(fmt(i.at))}</li>`).join('')}</ul>
    <p style="margin:24px 0"><a href="${esc(config.appUrl)}/#/plans" style="background:#3b4cca;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Upgrade to keep them</a></p>
    <p>You can also download them now from each recording's Export menu.</p>`);
  return sendMail({ to: user.email, subject, text, html });
}
