import crypto from 'node:crypto';
import { db, now, newId } from '../db.js';
import { config } from '../config.js';
import { sendOtpEmail, sendWelcomeEmail } from './mailer.js';
import { sendWhatsAppOtp } from './whatsapp.js';
import { planOf } from './plans.js';

export const SESSION_COOKIE = 'sid';
const PENDING_TTL = 15 * 60 * 1000;
export const OTP_TTL = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN = 30 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('hex');

export function cookieOptions(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: maxAgeMs };
}

// ---------- users ----------

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function publicUser(u) {
  if (!u) return null;
  const ids = db.prepare('SELECT provider FROM identities WHERE user_id = ?').all(u.id).map((r) => r.provider);
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, avatarUrl: u.avatar_url, plan: u.plan, providers: ids,
    createdAt: u.created_at, preferredLang: u.preferred_lang || 'en',
    planName: planOf(u).name, planInterval: u.plan_interval || null, features: planOf(u).features, retention: planOf(u).retention,
  };
}

/**
 * Find or create the user for an external identity.
 * Links to an existing account when the verified email (or phone) matches.
 */
export function upsertIdentity({ provider, providerUserId, email, phone, name, avatarUrl }) {
  const ident = db.prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?').get(provider, providerUserId);
  let user = ident && getUser(ident.user_id);
  let isNew = false;
  if (!user && email) user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user && phone) user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    isNew = true;
    const id = newId();
    db.prepare('INSERT INTO users (id, email, phone, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email || null, phone || null, name || null, avatarUrl || null, now());
    user = getUser(id);
  } else {
    db.prepare(`UPDATE users SET
        email = COALESCE(email, ?), phone = COALESCE(phone, ?),
        name = COALESCE(name, ?), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`)
      .run(email || null, phone || null, name || null, avatarUrl || null, user.id);
    user = getUser(user.id);
  }
  if (!ident) {
    db.prepare('INSERT OR IGNORE INTO identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(provider, providerUserId, user.id, now());
  }
  return { user, isNew };
}

/** Sends the official welcome email once, as soon as we know the user's email. */
export async function maybeSendWelcome(user) {
  if (!user.email || user.welcome_sent_at) return;
  db.prepare('UPDATE users SET welcome_sent_at = ? WHERE id = ?').run(now(), user.id);
  try { await sendWelcomeEmail(user); } catch (e) { console.error('welcome email failed', e.message); }
}

// ---------- sessions ----------
export function createPendingSession(userId, provider, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id_hash, user_id, verified, provider, user_agent, created_at, expires_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run(sha256(token), userId, provider, (userAgent || '').slice(0, 300), now(), now() + PENDING_TTL);
  return token;
}

export function loadSession(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(sha256(token));
  if (!s) return null;
  if (s.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash); return null; }
  return s;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
}

// ---------- OTP ----------
function otpChannel(user) {
  if (user.email) return { channel: 'email', destination: user.email };
  if (user.phone) return { channel: 'whatsapp', destination: user.phone };
  return null;
}

export function maskDestination(channel, d) {
  if (!d) return '';
  if (channel === 'email') {
    const [a, b] = d.split('@');
    return `${a.slice(0, 2)}${'*'.repeat(Math.max(1, a.length - 2))}@${b}`;
  }
  return `${d.slice(0, 3)}${'*'.repeat(Math.max(1, d.length - 5))}${d.slice(-2)}`;
}

/** Generates and delivers a fresh 6-digit OTP for a pending session. */
export async function issueOtp(session, { preferChannel, email } = {}) {
  const user = getUser(session.user_id);
  const hourCount = db.prepare('SELECT COUNT(*) AS n FROM otps o JOIN sessions s ON s.id_hash = o.session_hash WHERE s.user_id = ? AND o.created_at > ?')
    .get(user.id, now() - 3600_000).n;
  if (hourCount >= 10) { const err = new Error('Too many codes requested. Try again in an hour.'); err.status = 429; throw err; }

  let target = otpChannel(user);
  if (preferChannel === 'whatsapp' && user.phone) target = { channel: 'whatsapp', destination: user.phone };
  if (email) target = { channel: 'email', destination: email };
  if (!target) { const err = new Error('No email or phone on this account.'); err.status = 400; throw err; }
  const last = db.prepare('SELECT created_at FROM otps WHERE session_hash = ? AND consumed = 0 AND destination = ? ORDER BY id DESC LIMIT 1')
    .get(session.id_hash, target.destination);
  if (last && now() - last.created_at < OTP_RESEND_COOLDOWN) {
    const wait = Math.ceil((OTP_RESEND_COOLDOWN - (now() - last.created_at)) / 1000);
    const err = new Error(`Please wait ${wait}s before requesting another code.`); err.status = 429; throw err;
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('UPDATE otps SET consumed = 1 WHERE session_hash = ? AND consumed = 0').run(session.id_hash);
  db.prepare('INSERT INTO otps (session_hash, code_hash, channel, destination, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(session.id_hash, hmac(`${session.id_hash}:${code}`), target.channel, target.destination, now(), now() + OTP_TTL);
  // keep the pending session alive while the user waits for the code
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(now() + PENDING_TTL, session.id_hash);

  if (target.channel === 'email') await sendOtpEmail(target.destination, code);
  else await sendWhatsAppOtp(target.destination, code);
  return { channel: target.channel, destination: maskDestination(target.channel, target.destination) };
}

/** Checks an OTP. On success the session becomes fully signed in. */
export function verifyOtp(session, code) {
  const otp = db.prepare('SELECT * FROM otps WHERE session_hash = ? AND consumed = 0 ORDER BY id DESC LIMIT 1').get(session.id_hash);
  if (!otp || otp.expires_at < now()) return { ok: false, error: 'This code has expired. Request a new one.' };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'Too many wrong attempts. Request a new code.' };
  const expected = Buffer.from(otp.code_hash, 'hex');
  const given = Buffer.from(hmac(`${session.id_hash}:${String(code).trim()}`), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(otp.id);
    const left = OTP_MAX_ATTEMPTS - otp.attempts - 1;
    return { ok: false, error: left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Too many wrong attempts. Request a new code.' };
  }
  db.prepare('UPDATE otps SET consumed = 1 WHERE id = ?').run(otp.id);
  let userId = session.user_id;
  const user = getUser(userId);
  // A code sent to a new email address proves ownership: attach it to the account.
  if (otp.channel === 'email' && otp.destination && (user.email || '').toLowerCase() !== otp.destination.toLowerCase()) {
    const owner = db.prepare('SELECT * FROM users WHERE email = ?').get(otp.destination);
    if (owner && owner.id !== user.id) {
      const recs = db.prepare('SELECT COUNT(*) AS n FROM recordings WHERE user_id = ?').get(user.id).n;
      if (recs > 0) return { ok: false, error: 'That email already belongs to another account.' };
      // merge this (new, empty) account into the existing one
      db.prepare('UPDATE identities SET user_id = ? WHERE user_id = ?').run(owner.id, user.id);
      db.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(owner.id, user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // sessions/otps were moved first
      if (user.phone && !owner.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(user.phone, owner.id);
      userId = owner.id;
    } else {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(otp.destination, user.id);
    }
  }
  db.prepare('UPDATE sessions SET verified = 1, expires_at = ? WHERE id_hash = ?')
    .run(now() + config.sessionDays * 86400_000, session.id_hash);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  return { ok: true, user: getUser(userId) };
}

/** Starts a login for a resolved identity: creates a pending session, welcome email, OTP. */
export async function beginLogin(res, req, identity, { preferChannel } = {}) {
  const { user, isNew } = upsertIdentity(identity);
  const token = createPendingSession(user.id, identity.provider, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, cookieOptions(config.sessionDays * 86400_000));
  if (isNew) await maybeSendWelcome(user);
  const session = loadSession(token);
  let otp = null;
  if (user.email || user.phone) otp = await issueOtp(session, { preferChannel });
  return { user, isNew, otp, needsEmail: !user.email };
}

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  return (req, res, next) => {
    const k = `${req.path}:${key(req)}`;
    const t = now();
    const b = buckets.get(k) || { start: t, n: 0 };
    if (t - b.start > windowMs) { b.start = t; b.n = 0; }
    b.n++;
    buckets.set(k, b);
    if (b.n > max) return res.status(429).json({ error: 'Too many requests, slow down.' });
    next();
  };
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 3600_000) buckets.delete(k); }, 600_000).unref();
