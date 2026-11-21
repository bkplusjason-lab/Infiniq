import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { db, now, newId } from '../db.js';
import { SESSION_COOKIE, loadSession, getUser, publicUser, destroySession } from '../services/auth.js';
import { buildSpeakers, clusterSpeakersByPitch } from '../services/voices.js';
import { transcribeFile, transcriptionAvailable } from '../services/transcribe.js';
import { generateNotes, notesAvailable } from '../services/notes.js';
import { saveLiveTranslation } from './translate.js';
import { LANG_RE, sourceHash } from '../services/translate.js';

export const recRouter = Router();
const KINDS = ['sermon', 'lecture', 'meeting', 'other'];
const audioDir = path.join(config.dataDir, 'audio');

export function requireUser(req, res, next) {
  const s = loadSession(req.cookies[SESSION_COOKIE]);
  if (!s || !s.verified) return res.status(401).json({ error: 'Please sign in.' });
  req.session = s;
  req.user = getUser(s.user_id);
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}
recRouter.use('/api/recordings', requireUser);
recRouter.use('/api/me', requireUser);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = path.join(audioDir, req.user.id); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav' }[file.mimetype.split(';')[0]] || '.webm')
        .toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${newId()}${ext}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024, fieldSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(audio|video)\//.test(file.mimetype)),
});

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const clean = (s, n) => String(s ?? '').slice(0, n);

function sanitizeSegments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20000).map((s) => ({
    start: Math.max(0, Number(s.start) || 0),
    end: Math.max(0, Number(s.end) || Number(s.start) || 0),
    text: clean(s.text, 5000).trim(),
    speaker: s.speaker == null || s.speaker === '' ? null : clean(s.speaker, 20),
  })).filter((s) => s.text);
}
function sanitizePitch(p) {
  if (!p || !Array.isArray(p.f0) || !(p.step > 0)) return null;
  return { step: Number(p.step), f0: p.f0.slice(0, 200000).map((v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)))) };
}

function view(r, full = false) {
  const base = {
    id: r.id, title: r.title, kind: r.kind, tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
    language: r.language, durationSec: r.duration_sec, status: r.status, error: r.error,
    hasAudio: !!r.audio_file, transcriptSource: r.transcript_source, createdAt: r.created_at, updatedAt: r.updated_at,
    hasAiNotes: !!r.ai_notes_md,
  };
  if (!full) {
    const segs = parse(r.segments_json, []);
    return { ...base, preview: segs.slice(0, 3).map((s) => s.text).join(' ').slice(0, 220), speakerCount: Object.keys(parse(r.speakers_json, {})).length };
  }
  return {
    ...base, segments: parse(r.segments_json, []), speakers: parse(r.speakers_json, {}),
    bookmarks: parse(r.bookmarks_json, []), notes: r.notes_md, aiNotes: r.ai_notes_md,
  };
}

const getOwned = (req) => db.prepare('SELECT * FROM recordings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

async function runTranscription(id) {
  const r = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
  if (!r?.audio_file) return;
  try {
    db.prepare("UPDATE recordings SET status = 'transcribing', error = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    const out = await transcribeFile(path.join(audioDir, r.audio_file), { language: r.language, mime: r.mime });
    const pitch = parse(r.pitch_json, null);
    const segs = sanitizeSegments(out.segments);
    const speakers = buildSpeakers(segs, pitch, {});
    db.prepare(`UPDATE recordings SET status = 'ready', transcript_source = ?, segments_json = ?, speakers_json = ?,
        language = COALESCE(?, language), updated_at = ? WHERE id = ?`)
      .run(config.transcription.provider, JSON.stringify(segs), JSON.stringify(speakers), out.language || null, now(), id);
  } catch (e) {
    console.error('transcription failed', id, e.message);
    db.prepare("UPDATE recordings SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
      .run('Transcription failed: ' + e.message.slice(0, 300), now(), id);
  }
}
// jobs interrupted by a restart
db.prepare("UPDATE recordings SET status = 'error', error = 'Transcription was interrupted. Press Re-transcribe.' WHERE status = 'transcribing'").run();

// ---------- account ----------
recRouter.get('/api/me', (req, res) => {
  const u = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration_sec),0) AS secs, COALESCE(SUM(size_bytes),0) AS bytes FROM recordings WHERE user_id = ?').get(req.user.id);
  res.json({ user: publicUser(req.user), usage: { recordings: u.n, minutes: Math.round(u.secs / 60), bytes: u.bytes } });
});
recRouter.patch('/api/me', (req, res) => {
  const name = clean(req.body?.name, 100).trim();
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  const lang = req.body?.preferredLang;
  if (lang !== undefined) {
    if (!LANG_RE.test(String(lang))) return res.status(400).json({ error: 'Unknown language' });
    db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(lang, req.user.id);
  }
  res.json({ user: publicUser(getUser(req.user.id)) });
});
recRouter.delete('/api/me', (req, res) => {
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
  fs.rmSync(path.join(audioDir, req.user.id), { recursive: true, force: true });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  destroySession(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---------- recordings ----------
recRouter.get('/api/recordings', (req, res) => {
  const q = clean(req.query.q, 100).trim();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  let sql = 'SELECT * FROM recordings WHERE user_id = ?';
  const args = [req.user.id];
  if (kind) { sql += ' AND kind = ?'; args.push(kind); }
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    sql += " AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR notes_md LIKE ? ESCAPE '\\' OR segments_json LIKE ? ESCAPE '\\' OR ai_notes_md LIKE ? ESCAPE '\\')";
    args.push(like, like, like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json({ recordings: db.prepare(sql).all(...args).map((r) => view(r)) });
});

recRouter.post('/api/recordings', upload.single('audio'), async (req, res) => {
  const b = req.body || {};
  const id = newId();
  const kind = KINDS.includes(b.kind) ? b.kind : 'other';
  const title = clean(b.title, 200).trim() || `${kind[0].toUpperCase() + kind.slice(1)} – ${new Date().toLocaleString('en-GB')}`;
  const pitch = sanitizePitch(parse(b.pitch, null));
  let segments = sanitizeSegments(parse(b.segments, []));
  if (segments.length && segments.every((s) => !s.speaker)) segments = clusterSpeakersByPitch(segments, pitch);
  const speakers = buildSpeakers(segments, pitch, {});
  const bookmarks = (parse(b.bookmarks, []) || []).slice(0, 500).map((m) => ({ t: Number(m.t) || 0, label: clean(m.label, 200) }));
  const tags = clean(b.tags, 300).split(',').map((t) => t.trim()).filter(Boolean).join(',');
  const willTranscribe = !!req.file && transcriptionAvailable() && b.transcribe !== 'false';
  db.prepare(`INSERT INTO recordings (id, user_id, title, kind, tags, language, audio_file, mime, size_bytes, duration_sec, status,
      transcript_source, segments_json, speakers_json, pitch_json, bookmarks_json, notes_md, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, title, kind, tags, clean(b.language, 20) || null,
      req.file ? `${req.user.id}/${req.file.filename}` : null, req.file?.mimetype || null, req.file?.size || 0,
      Number(b.durationSec) || null, willTranscribe ? 'transcribing' : 'ready', segments.length ? 'browser' : null,
      JSON.stringify(segments), JSON.stringify(speakers), pitch ? JSON.stringify(pitch) : null, JSON.stringify(bookmarks),
      clean(b.notes, 200000), now(), now());
  saveLiveTranslation(req.user, id, segments, parse(b.liveTranslation, null));
  if (willTranscribe) runTranscription(id);
  res.status(201).json({ recording: view(db.prepare('SELECT * FROM recordings WHERE id = ?').get(id), true) });
});

recRouter.get('/api/recordings/:id', (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ recording: view(r, true) });
});

recRouter.get('/api/recordings/:id/audio', (req, res) => {
  const r = getOwned(req);
  if (!r?.audio_file) return res.status(404).end();
  res.type(r.mime || 'audio/webm');
  res.sendFile(path.join(audioDir, r.audio_file));
});

recRouter.patch('/api/recordings/:id', (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const sets = [], args = [];
  if (b.title !== undefined) { sets.push('title = ?'); args.push(clean(b.title, 200).trim() || r.title); }
  if (KINDS.includes(b.kind)) { sets.push('kind = ?'); args.push(b.kind); }
  if (Array.isArray(b.tags)) { sets.push('tags = ?'); args.push(b.tags.map((t) => clean(t, 40).trim().replace(/,/g, '')).filter(Boolean).slice(0, 20).join(',')); }
  if (typeof b.notes === 'string') { sets.push('notes_md = ?'); args.push(clean(b.notes, 200000)); }
  if (typeof b.aiNotes === 'string') { sets.push('ai_notes_md = ?'); args.push(clean(b.aiNotes, 200000)); }
  if (Array.isArray(b.bookmarks)) { sets.push('bookmarks_json = ?'); args.push(JSON.stringify(b.bookmarks.slice(0, 500).map((m) => ({ t: Number(m.t) || 0, label: clean(m.label, 200) })))); }
  let segments = parse(r.segments_json, []);
  if (Array.isArray(b.segments)) { segments = sanitizeSegments(b.segments); sets.push('segments_json = ?'); args.push(JSON.stringify(segments)); }
  if (b.speakers && typeof b.speakers === 'object' || Array.isArray(b.segments)) {
    const cur = parse(r.speakers_json, {});
    for (const [id, v] of Object.entries(b.speakers || {})) {
      if (!cur[id]) cur[id] = { name: `Speaker ${id}`, voice: 'unknown' };
      if (typeof v.name === 'string' && v.name.trim()) cur[id].name = clean(v.name, 60).trim();
      if (['male', 'female', 'unknown'].includes(v.voice)) { cur[id].voice = v.voice; cur[id].manualVoice = true; }
    }
    const rebuilt = buildSpeakers(segments, parse(r.pitch_json, null), cur);
    for (const id of Object.keys(cur)) if (!rebuilt[id] && segments.some((s) => s.speaker === id)) rebuilt[id] = cur[id];
    sets.push('speakers_json = ?'); args.push(JSON.stringify(rebuilt));
  }
  if (!sets.length) return res.json({ recording: view(r, true) });
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...args, r.id);
  res.json({ recording: view(getOwned(req), true) });
});

recRouter.post('/api/recordings/:id/transcribe', (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!r.audio_file) return res.status(400).json({ error: 'This item has no audio.' });
  if (!transcriptionAvailable()) return res.status(400).json({ error: 'No transcription service is configured on the server.' });
  if (r.status === 'transcribing') return res.status(409).json({ error: 'Already transcribing.' });
  db.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").run(r.id);
  runTranscription(r.id);
  res.json({ recording: view(getOwned(req), true) });
});

recRouter.post('/api/recordings/:id/notes', async (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!notesAvailable()) return res.status(400).json({ error: 'AI notes are not configured on the server (ANTHROPIC_API_KEY).' });
  try {
    const md = await generateNotes(r, parse(r.segments_json, []), parse(r.speakers_json, {}), parse(r.bookmarks_json, []));
    db.prepare('UPDATE recordings SET ai_notes_md = ?, updated_at = ? WHERE id = ?').run(md, now(), r.id);
    res.json({ recording: view(getOwned(req), true) });
  } catch (e) {
    console.error('notes failed', e);
    res.status(e.status || 502).json({ error: e.status ? e.message : 'Could not generate notes right now. Try again later.' });
  }
});

recRouter.delete('/api/recordings/:id', (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.audio_file) fs.rmSync(path.join(audioDir, r.audio_file), { force: true });
  db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

// ---------- export ----------
const ts = (t, sep = '.') => {
  const ms = Math.round((t % 1) * 1000), s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
};
const short = (t) => { const s = Math.floor(t); const h = Math.floor(s / 3600); return `${h ? h + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };

recRouter.get('/api/recordings/:id/export', (req, res) => {
  const r = getOwned(req);
  if (!r) return res.status(404).end();
  let segs = parse(r.segments_json, []);
  const sp = parse(r.speakers_json, {});
  const who = (id) => sp[id]?.name || 'Speaker';
  let title = r.title, aiNotes = r.ai_notes_md, myNotes = r.notes_md;
  // ?lang=xx exports the translated version (Live Translation add-on)
  if (req.query.lang && LANG_RE.test(String(req.query.lang))) {
    if (!(req.user.addons || '').split(',').includes('translation')) return res.status(402).json({ error: 'Translated exports need the Live Translation add-on.', code: 'upgrade_required' });
    const t = db.prepare('SELECT * FROM translations WHERE recording_id = ? AND lang = ?').get(r.id, req.query.lang);
    if (!t) return res.status(404).json({ error: 'No translation in that language yet.' });
    const tr = parse(t.segments_json, null);
    if (tr && t.source_hash === sourceHash(segs)) segs = segs.map((s, i) => ({ ...s, text: tr[i] || s.text }));
    else if (tr) segs = [];
    title = `${r.title} (${req.query.lang})`; aiNotes = t.ai_notes_md; myNotes = t.my_notes_md;
  }
  const fmt = ['txt', 'md', 'srt', 'vtt'].includes(req.query.format) ? req.query.format : 'txt';
  const date = new Date(r.created_at).toLocaleString('en-GB');
  let out;
  if (fmt === 'srt') out = segs.map((s, i) => `${i + 1}\n${ts(s.start, ',')} --> ${ts(s.end, ',')}\n${who(s.speaker)}: ${s.text}\n`).join('\n');
  else if (fmt === 'vtt') out = 'WEBVTT\n\n' + segs.map((s) => `${ts(s.start)} --> ${ts(s.end)}\n<v ${who(s.speaker)}>${s.text}\n`).join('\n');
  else if (fmt === 'md') {
    out = `# ${title}\n\n*${r.kind} · ${date}*\n\n`;
    if (aiNotes) out += `${aiNotes}\n\n---\n\n`;
    if (myNotes) out += `## My notes\n\n${myNotes}\n\n`;
    out += `## Transcript\n\n` + segs.map((s) => `**[${short(s.start)}] ${who(s.speaker)}:** ${s.text}`).join('\n\n') + '\n';
  } else {
    out = `${title}\n${r.kind} - ${date}\n\n`;
    if (myNotes) out += `MY NOTES\n${myNotes}\n\n`;
    if (aiNotes) out += `AI NOTES\n${aiNotes}\n\n`;
    out += 'TRANSCRIPT\n' + segs.map((s) => `[${short(s.start)}] ${who(s.speaker)}: ${s.text}`).join('\n') + '\n';
  }
  const name = title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'recording';
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${fmt}"`);
  res.type(fmt === 'md' ? 'text/markdown' : fmt === 'vtt' ? 'text/vtt' : 'text/plain').send(out);
});
