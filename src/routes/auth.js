import crypto from 'node:crypto';
import { Router } from 'express';
import { config, providers } from '../config.js';
import {
  SESSION_COOKIE, beginLogin, loadSession, issueOtp, verifyOtp, destroySession,
  getUser, publicUser, maybeSendWelcome, rateLimit, maskDestination, cookieOptions,
} from '../services/auth.js';
import { normalizePhone } from '../services/whatsapp.js';
import { db } from '../db.js';

export const authRouter = Router();
const STATE_COOKIE = 'oauth_state';
const strictLimit = rateLimit({ windowMs: 15 * 60_000, max: 20 });
const isEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

function startOAuth(res, provider, authUrl, params) {
  const state = crypto.randomBytes(24).toString('base64url');
  res.cookie(STATE_COOKIE, `${provider}:${state}`, { ...cookieOptions(10 * 60_000) });
  const u = new URL(authUrl);
  for (const [k, v] of Object.entries({ ...params, state })) u.searchParams.set(k, v);
  res.redirect(u.toString());
}

function checkState(req, res, provider) {
  const expected = req.cookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/' });
  return expected && req.query.state && expected === `${provider}:${req.query.state}`;
}

const fail = (res, msg) => res.redirect(`/#/login?error=${encodeURIComponent(msg)}`);
const afterLogin = (res, r) => res.redirect(r.needsEmail ? '/#/otp?needEmail=1' : '/#/otp');

// ---------------- Google ----------------
authRouter.get('/auth/google', (req, res) => {
  if (!providers.google) return res.redirect('/#/login?dev=google');
  startOAuth(res, 'google', 'https://accounts.google.com/o/oauth2/v2/auth', {
    client_id: config.google.clientId,
    redirect_uri: `${config.appUrl}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
});

authRouter.get('/auth/google/callback', async (req, res) => {
  try {
    if (!checkState(req, res, 'google')) return fail(res, 'Login session expired, please try again.');
    if (req.query.error) return fail(res, 'Google sign-in was cancelled.');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code), client_id: config.google.clientId, client_secret: config.google.clientSecret,
        redirect_uri: `${config.appUrl}/auth/google/callback`, grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('Google token exchange failed');
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })).json();
    if (!info.sub) throw new Error('Google profile unavailable');
    const r = await beginLogin(res, req, {
      provider: 'google', providerUserId: info.sub, name: info.name, avatarUrl: info.picture,
      email: info.email_verified ? info.email : null,
    });
    afterLogin(res, r);
  } catch (e) {
    console.error('google login', e);
    fail(res, 'Google sign-in failed. Please try again.');
  }
});

// ---------------- Facebook ----------------
const FB = 'https://graph.facebook.com/v21.0';
authRouter.get('/auth/facebook', (req, res) => {
  if (!providers.facebook) return res.redirect('/#/login?dev=facebook');
  startOAuth(res, 'facebook', 'https://www.facebook.com/v21.0/dialog/oauth', {
    client_id: config.facebook.appId,
    redirect_uri: `${config.appUrl}/auth/facebook/callback`,
    scope: 'email,public_profile',
    response_type: 'code',
  });
});

authRouter.get('/auth/facebook/callback', async (req, res) => {
  try {
    if (!checkState(req, res, 'facebook')) return fail(res, 'Login session expired, please try again.');
    if (req.query.error) return fail(res, 'Facebook login was cancelled.');
    const t = new URL(`${FB}/oauth/access_token`);
    t.search = new URLSearchParams({
      client_id: config.facebook.appId, client_secret: config.facebook.appSecret,
      redirect_uri: `${config.appUrl}/auth/facebook/callback`, code: String(req.query.code),
    });
    const tokens = await (await fetch(t)).json();
    if (!tokens.access_token) throw new Error('Facebook token exchange failed');
    const proof = crypto.createHmac('sha256', config.facebook.appSecret).update(tokens.access_token).digest('hex');
    const me = await (await fetch(`${FB}/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(tokens.access_token)}&appsecret_proof=${proof}`)).json();
    if (!me.id) throw new Error('Facebook profile unavailable');
    const r = await beginLogin(res, req, {
      provider: 'facebook', providerUserId: me.id, name: me.name, email: me.email || null,
      avatarUrl: me.picture?.data?.url,
    });
    afterLogin(res, r);
  } catch (e) {
    console.error('facebook login', e);
    fail(res, 'Facebook login failed. Please try again.');
  }
});

// ---------------- WhatsApp (phone number + code sent via WhatsApp) ----------------
authRouter.post('/api/auth/whatsapp', strictLimit, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter your WhatsApp number with country code, e.g. +6591234567.' });
  try {
    const r = await beginLogin(res, req, { provider: 'whatsapp', providerUserId: phone, phone }, { preferChannel: 'whatsapp' });
    res.json({ ok: true, otp: r.otp, needsEmail: r.needsEmail });
  } catch (e) {
    console.error('whatsapp login', e);
    res.status(e.status || 502).json({ error: e.status ? e.message : 'Could not send the WhatsApp code. Check the number and try again.' });
  }
});

// ---------------- Developer test logins (only when real keys are missing) ----------------
authRouter.post('/api/auth/dev', strictLimit, async (req, res) => {
  const { provider, email, name } = req.body || {};
  if (!config.devLogin) return res.status(404).json({ error: 'Not available' });
  if (!['google', 'facebook'].includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  if (providers[provider]) return res.status(400).json({ error: `${provider} is configured; use the real login.` });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  const r = await beginLogin(res, req, {
    provider, providerUserId: `dev-${(email || name || 'user').toLowerCase()}`, email: email || null, name: name || null,
  });
  res.json({ ok: true, otp: r.otp, needsEmail: r.needsEmail });
});

// ---------------- OTP ----------------
function requireAnySession(req, res, next) {
  const s = loadSession(req.cookies[SESSION_COOKIE]);
  if (!s) return res.status(401).json({ error: 'Your sign-in expired. Please start again.' });
  req.session = s;
  next();
}

authRouter.post('/api/auth/otp/resend', strictLimit, requireAnySession, async (req, res) => {
  try {
    res.json({ ok: true, otp: await issueOtp(req.session, { preferChannel: req.body?.channel }) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not send a new code.' });
  }
});

authRouter.post('/api/auth/otp/verify', rateLimit({ windowMs: 15 * 60_000, max: 30 }), requireAnySession, async (req, res) => {
  const code = String(req.body?.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
  const r = verifyOtp(req.session, code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  await maybeSendWelcome(r.user);
  res.json({ ok: true, user: publicUser(r.user), needsEmail: !r.user.email });
});

/** Add an email to an account that has none (Facebook without email, WhatsApp users). */
authRouter.post('/api/auth/email', strictLimit, requireAnySession, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const user = getUser(req.session.user_id);
  if (user.email) return res.status(400).json({ error: 'This account already has an email.' });
  try {
    const otp = await issueOtp(req.session, { email });
    res.json({ ok: true, otp });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not send the code.' });
  }
});

authRouter.get('/api/auth/status', (req, res) => {
  const s = loadSession(req.cookies[SESSION_COOKIE]);
  if (!s) return res.json({ state: 'signed_out' });
  const user = getUser(s.user_id);
  if (!s.verified) {
    const otp = db.prepare('SELECT channel, destination FROM otps WHERE session_hash = ? AND consumed = 0 ORDER BY id DESC LIMIT 1').get(s.id_hash);
    return res.json({
      state: 'otp_required', needsEmail: !user.email,
      otp: otp ? { channel: otp.channel, destination: maskDestination(otp.channel, otp.destination) } : null,
    });
  }
  res.json({ state: 'signed_in', user: publicUser(user), needsEmail: !user.email });
});

authRouter.post('/api/auth/logout', (req, res) => {
  destroySession(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

export { requireAnySession };
