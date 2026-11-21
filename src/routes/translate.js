// Plans & billing (test mode), and the Pro-only translation features: live caption translation,
// and translation of saved transcripts and notes/minutes.
import { Router } from 'express';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { getUser, publicUser, rateLimit } from '../services/auth.js';
import { PLANS, planOf, can, usageOf, publicPlans, recordUsage, checkTranslation, sendLimit } from '../services/plans.js';
import { requireUser } from './recordings.js';
import {
  translateTexts, translateMarkdown, translationAvailable, isMock, languageName, sourceHash, LANG_RE,
} from '../services/translate.js';
import { generateNotes, notesAvailable } from '../services/notes.js';

export const translateRouter = Router();
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function requireTranslation(req, res, next) {
  if (!can(req.user, 'translation')) {
    return res.status(402).json({ error: 'Live translation is part of the Pro plan. Upgrade in Account → Plans.', code: 'upgrade_required', feature: 'translation' });
  }
  if (!translationAvailable()) return res.status(503).json({ error: 'Translation is not configured on the server.' });
  next();
}

// ---------------- plans & billing ----------------
translateRouter.get('/api/billing/plans', requireUser, (req, res) => {
  res.json({
    testMode: config.billing.testMode,
    plans: publicPlans(),
    current: { plan: planOf(req.user).id, interval: req.user.plan_interval || null },
    usage: usageOf(req.user),
  });
});

/** Changes a user's plan. Real billing (e.g. a Stripe webhook) should call this too. */
export function setPlan(userId, plan, interval, { test = false } = {}) {
  db.prepare('UPDATE users SET plan = ?, plan_interval = ?, plan_changed_at = ? WHERE id = ?').run(plan, plan === 'free' ? null : interval, now(), userId);
  // re-evaluate retention warnings under the new plan
  db.prepare('UPDATE recordings SET warned_audio_at = NULL, warned_text_at = NULL WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO billing_events (user_id, type, plan, interval, test, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, plan === 'free' ? 'cancel' : 'subscribe', plan, interval || null, test ? 1 : 0, now());
}

// Test mode only: switch plans without paying.
translateRouter.post('/api/billing/test/subscribe', requireUser, (req, res) => {
  if (!config.billing.testMode) return res.status(404).json({ error: 'Not available' });
  const { plan, interval = 'month' } = req.body || {};
  if (!PLANS[plan] || !['month', 'year'].includes(interval)) return res.status(400).json({ error: 'Unknown plan' });
  setPlan(req.user.id, plan, interval, { test: true });
  res.json({ user: publicUser(getUser(req.user.id)) });
});

// ---------------- live translation ----------------
const liveLimit = rateLimit({ windowMs: 60_000, max: 120, key: (req) => req.user.id });
translateRouter.post('/api/translate/live', requireUser, requireTranslation, liveLimit, async (req, res) => {
  const { texts, context, source, target } = req.body || {};
  if (!LANG_RE.test(target || '')) return res.status(400).json({ error: 'Choose a language to translate to.' });
  if (!Array.isArray(texts) || !texts.length || texts.length > 20) return res.status(400).json({ error: 'Send 1–20 lines.' });
  const clean = texts.map((t) => String(t ?? '').slice(0, 2000));
  const ctx = Array.isArray(context) ? context.slice(-4).map((t) => String(t ?? '').slice(0, 1000)) : [];
  const chars = clean.join('').length;
  try { checkTranslation(req.user, chars); } catch (e) { return sendLimit(res, e); }
  try {
    const translations = await translateTexts(clean, { target, source: LANG_RE.test(source || '') ? source : 'auto', context: ctx, live: true });
    recordUsage(req.user.id, 'translation_chars', chars);
    res.json({ translations, demo: isMock() });
  } catch (e) {
    console.error('live translation failed', e.message);
    res.status(e.status || 502).json({ error: e.status ? e.message : 'Translation is temporarily unavailable.' });
  }
});

// ---------------- recording translations ----------------
const ownedRec = (req) => db.prepare('SELECT * FROM recordings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

function viewTranslation(t, rec) {
  if (!t) return null;
  const segs = parse(rec.segments_json, []);
  return {
    lang: t.lang, languageName: languageName(t.lang), origin: t.origin, updatedAt: t.updated_at,
    segments: t.segments_json ? parse(t.segments_json, null) : null,
    stale: !!t.segments_json && t.source_hash !== sourceHash(segs),
    aiNotes: t.ai_notes_md, myNotes: t.my_notes_md, demo: isMock(),
  };
}

translateRouter.get('/api/recordings/:id/translations', requireUser, (req, res) => {
  const rec = ownedRec(req);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM translations WHERE recording_id = ? ORDER BY updated_at DESC').all(rec.id);
  res.json({ translations: rows.map((t) => viewTranslation(t, rec)) });
});

translateRouter.post('/api/recordings/:id/translations', requireUser, requireTranslation, async (req, res) => {
  const rec = ownedRec(req);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const { lang, what } = req.body || {};
  if (!LANG_RE.test(lang || '')) return res.status(400).json({ error: 'Choose a language.' });
  if (!['transcript', 'notes', 'mynotes'].includes(what)) return res.status(400).json({ error: 'Unknown item' });
  const segs = parse(rec.segments_json, []);
  const chars = what === 'mynotes' ? (rec.notes_md || '').length : segs.reduce((n, s) => n + s.text.length, 0);
  try { checkTranslation(req.user, chars); } catch (e) { return sendLimit(res, e); }
  const existing = db.prepare('SELECT * FROM translations WHERE recording_id = ? AND lang = ?').get(rec.id, lang);
  db.prepare('INSERT OR IGNORE INTO translations (recording_id, lang, origin, updated_at) VALUES (?, ?, ?, ?)').run(rec.id, lang, 'manual', now());
  try {
    if (what === 'transcript') {
      if (!segs.length) return res.status(400).json({ error: 'There is no transcript to translate.' });
      const out = await translateTexts(segs.map((s) => s.text), { target: lang, source: rec.language });
      db.prepare('UPDATE translations SET segments_json = ?, source_hash = ?, origin = ?, updated_at = ? WHERE recording_id = ? AND lang = ?')
        .run(JSON.stringify(out), sourceHash(segs), 'manual', now(), rec.id, lang);
    } else if (what === 'notes') {
      if (!segs.length) return res.status(400).json({ error: 'There is no transcript yet.' });
      let md;
      if (notesAvailable()) {
        md = await generateNotes(rec, segs, parse(rec.speakers_json, {}), parse(rec.bookmarks_json, []), { outputLanguage: languageName(lang) });
      } else if (isMock()) {
        const lines = await translateTexts(segs.slice(0, 10).map((s) => s.text), { target: lang });
        md = `# ${rec.title}\n\n> Demo notes in ${languageName(lang)} (no AI key configured)\n\n## Key Points\n${lines.map((l) => `- ${l}`).join('\n')}`;
      } else return res.status(400).json({ error: 'AI notes are not configured on the server.' });
      db.prepare('UPDATE translations SET ai_notes_md = ?, updated_at = ? WHERE recording_id = ? AND lang = ?').run(md, now(), rec.id, lang);
    } else {
      if (!rec.notes_md?.trim()) return res.status(400).json({ error: 'You have no notes on this recording to translate.' });
      const md = await translateMarkdown(rec.notes_md, { target: lang });
      db.prepare('UPDATE translations SET my_notes_md = ?, updated_at = ? WHERE recording_id = ? AND lang = ?').run(md, now(), rec.id, lang);
    }
  } catch (e) {
    if (!existing) db.prepare('DELETE FROM translations WHERE recording_id = ? AND lang = ? AND segments_json IS NULL AND ai_notes_md IS NULL AND my_notes_md IS NULL').run(rec.id, lang);
    console.error('translation failed', e.message);
    return res.status(e.status || 502).json({ error: e.status ? e.message : 'Translation failed. Please try again.' });
  }
  recordUsage(req.user.id, 'translation_chars', chars);
  const t = db.prepare('SELECT * FROM translations WHERE recording_id = ? AND lang = ?').get(rec.id, lang);
  res.json({ translation: viewTranslation(t, rec) });
});

translateRouter.delete('/api/recordings/:id/translations/:lang', requireUser, (req, res) => {
  const rec = ownedRec(req);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM translations WHERE recording_id = ? AND lang = ?').run(rec.id, req.params.lang);
  res.json({ ok: true });
});

/** Saves live-caption translations captured during recording (called from the upload route). */
export function saveLiveTranslation(user, recId, segments, live) {
  if (!live || !can(user, 'translation') || !LANG_RE.test(live.lang || '') || !Array.isArray(live.texts)) return;
  if (!segments.length) return;
  const texts = segments.map((_, i) => String(live.texts[i] ?? '').slice(0, 5000));
  if (!texts.some(Boolean)) return;
  db.prepare(`INSERT OR REPLACE INTO translations (recording_id, lang, source_hash, segments_json, origin, updated_at)
      VALUES (?, ?, ?, ?, 'live', ?)`).run(recId, live.lang, sourceHash(segments), JSON.stringify(texts), now());
}

export { publicUser };
