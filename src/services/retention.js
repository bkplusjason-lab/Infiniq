// Deletes expired audio / recordings according to each user's plan,
// and emails a warning WARN_DAYS before anything is removed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { expiryOf, WARN_DAYS } from './plans.js';
import { sendRetentionWarning } from './mailer.js';

const audioDir = path.join(config.dataDir, 'audio');
const DAY = 86400_000;

export async function runRetention(t = now()) {
  const rows = db.prepare(`SELECT r.id, r.user_id, r.title, r.audio_file, r.created_at, r.warned_audio_at, r.warned_text_at,
      u.plan, u.plan_changed_at FROM recordings r JOIN users u ON u.id = r.user_id`).all();
  const warnings = new Map();
  const stats = { audioDeleted: 0, recordingsDeleted: 0, warned: 0 };
  for (const r of rows) {
    const user = { plan: r.plan, plan_changed_at: r.plan_changed_at };
    const { audioDeleteAt, textDeleteAt } = expiryOf(r, user);
    if (textDeleteAt && textDeleteAt <= t) {
      if (r.audio_file) fs.rmSync(path.join(audioDir, r.audio_file), { force: true });
      db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
      stats.recordingsDeleted++;
      continue;
    }
    if (audioDeleteAt && audioDeleteAt <= t) {
      fs.rmSync(path.join(audioDir, r.audio_file), { force: true });
      db.prepare('UPDATE recordings SET audio_file = NULL, audio_deleted_at = ? WHERE id = ?').run(t, r.id);
      stats.audioDeleted++;
      continue;
    }
    const add = (what, at) => { if (!warnings.has(r.user_id)) warnings.set(r.user_id, []); warnings.get(r.user_id).push({ id: r.id, title: r.title, what, at }); };
    if (textDeleteAt && textDeleteAt - t <= WARN_DAYS * DAY && !r.warned_text_at) add('text', textDeleteAt);
    else if (audioDeleteAt && audioDeleteAt - t <= WARN_DAYS * DAY && !r.warned_audio_at) add('audio', audioDeleteAt);
  }
  for (const [userId, items] of warnings) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    try {
      if (user?.email) await sendRetentionWarning(user, items);
      for (const i of items) db.prepare(`UPDATE recordings SET ${i.what === 'audio' ? 'warned_audio_at' : 'warned_text_at'} = ? WHERE id = ?`).run(t, i.id);
      stats.warned += items.length;
    } catch (e) { console.error('retention warning failed', e.message); }
  }
  return stats;
}

export function startRetentionJob() {
  const tick = () => runRetention().then((s) => { if (s.audioDeleted || s.recordingsDeleted || s.warned) console.log('[retention]', s); }).catch((e) => console.error('[retention]', e));
  tick();
  setInterval(tick, 3600_000).unref();
}
