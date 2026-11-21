// Paid "Live Translation" add-on: billing (test mode), live caption translation,
// and translation of saved transcripts and notes/minutes.
import { Router } from 'express';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { getUser, publicUser, hasAddon, addonsOf, rateLimit } from '../services/auth.js';
import { requireUser } from './recordings.js';
import {
  translateTexts, translateMarkdown, translationAvailable, isMock, languageName, sourceHash, LANG_RE,
} from '../services/translate.js';
import { generateNotes, notesAvailable } from '../services/notes.js';

export const translateRouter = Router();
export const ADDONS = {
  translation: {
    id: 'translation',
    name: 'Live Translation',
    price: () => config.billing.translationPrice,
    features: [
      'Real-time translated captions while recording sermons, lectures and meetings',
      'Live conversation interpreter with read-aloud',
      'Translate full transcripts into 30+ languages',
      'Sermon notes and meeting minutes written in your preferred language',
      'Export translated transcripts and subtitles',
    ],
  },
};

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function requireAddon(addon) {
  return (req, res, next) => {
    if (!hasAddon(req.user, addon)) {
      return res.status(402).json({ error: `This feature is part of the ${ADDONS[addon].name} add-on. Upgrade in Account → Plans.`, code: 'upgrade_required', addon });
    }
    if (!translationAvailable()) return res.status(503).json({ error: 'Translation is not configured on the server.' });
    next();
  };
}

// ---------------- billing ----------------
translateRouter.get('/api/billing/plans', requireUser, (req, res) => {
  const active = addonsOf(req.user);
  res.json({
    testMode: config.billing.testMode,
    addons: Object.values(ADDONS).map((a) => ({ id: a.id, name: a.name, price: a.price(), features: a.features, active: active.includes(a.id) })),
  });
});

function setAddon(userId, addon, on) {
  const u = getUser(userId);
  const set = new Set(addonsOf(u));
  on ? set.add(addon) : set.delete(addon);
  db.prepare('UPDATE users SET addons = ? WHERE id = ?').run([...set].join(','), userId);
  db.prepare('INSERT INTO billing_events (user_id, type, addon, test, created_at) VALUES (?, ?, ?, 1, ?)').run(userId, on ? 'activate' : 'cancel', addon, now());
}

// Test-mode only: lets testers switch the paid add-on on/off without paying.
// When Stripe (or similar) is added, its webhook calls setAddon() instead.
translateRouter.post('/api/billing/test/:action', requireUser, (req, res) => {
  if (!config.billing.testMode) return res.status(404).json({ error: 'Not available' });
  const addon = req.body?.addon;
  if (!ADDONS[addon] || !['activate', 'cancel'].includes(req.params.action)) return res.status(400).json({ error: 'Unknown add-on' });
  setAddon(req.user.id, addon, req.params.action === 'activate');
  res.json({ user: publicUser(getUser(req.user.id)) });
});

// ---------------- live translation ----------------
const liveLimit = rateLimit({ windowMs: 60_000, max: 120, key: (req) => req.user.id });
translateRouter.post('/api/translate/live', requireUser, requireAddon('translation'), liveLimit, async (req, res) => {
  const { texts, context, source, target } = req.body || {};
  if (!LANG_RE.test(target || '')) return res.status(400).json({ error: 'Choose a language to translate to.' });
  if (!Array.isArray(texts) || !texts.length || texts.length > 20) return res.status(400).json({ error: 'Send 1–20 lines.' });
  const clean = texts.map((t) => String(t ?? '').slice(0, 2000));
  const ctx = Array.isArray(context) ? context.slice(-4).map((t) => String(t ?? '').slice(0, 1000)) : [];
  try {
    const translations = await translateTexts(clean, { target, source: LANG_RE.test(source || '') ? source : 'auto', context: ctx, live: true });
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

translateRouter.post('/api/recordings/:id/translations', requireUser, requireAddon('translation'), async (req, res) => {
  const rec = ownedRec(req);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const { lang, what } = req.body || {};
  if (!LANG_RE.test(lang || '')) return res.status(400).json({ error: 'Choose a language.' });
  if (!['transcript', 'notes', 'mynotes'].includes(what)) return res.status(400).json({ error: 'Unknown item' });
  const segs = parse(rec.segments_json, []);
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
  if (!live || !hasAddon(user, 'translation') || !LANG_RE.test(live.lang || '') || !Array.isArray(live.texts)) return;
  if (!segments.length) return;
  const texts = segments.map((_, i) => String(live.texts[i] ?? '').slice(0, 5000));
  if (!texts.some(Boolean)) return;
  db.prepare(`INSERT OR REPLACE INTO translations (recording_id, lang, source_hash, segments_json, origin, updated_at)
      VALUES (?, ?, ?, ?, 'live', ?)`).run(recId, live.lang, sourceHash(segments), JSON.stringify(texts), now());
}

export { publicUser };
