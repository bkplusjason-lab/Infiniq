// Subscription plans, usage metering and limit checks.
// Edit PLANS to change prices or limits; everything else reads from here.
import { config } from '../config.js';
import { db, now } from '../db.js';

const H = 3600;
export const PLANS = {
  free: {
    id: 'free', name: 'Free', price: { month: 0, year: 0 },
    tagline: 'Try it for the occasional sermon, lecture or meeting',
    limits: {
      recordingsPerDay: 1,          // rolling 24 hours
      maxRecordingSec: 60 * 60,     // 60 minutes per recording
      recordingSecPerMonth: 300 * 60,
      aiTranscriptionSecPerMonth: 60 * 60, // speaker detection for imported files
      aiNotesPerMonth: 3,
      translationCharsPerMonth: 0,
    },
    features: { aiTranscription: true, translation: false, exports: ['txt'] },
    retention: { audioDays: 30, textDays: 365 },
  },
  plus: {
    id: 'plus', name: 'Plus', price: { month: 4, year: 36 },
    tagline: 'Unlimited recording with AI speaker detection',
    limits: {
      recordingsPerDay: null,
      maxRecordingSec: 4 * H,
      recordingSecPerMonth: 30 * H, // fair use
      aiTranscriptionSecPerMonth: 30 * H,
      aiNotesPerMonth: null,
      translationCharsPerMonth: 0,
    },
    features: { aiTranscription: true, translation: false, exports: ['txt', 'md', 'srt', 'vtt'] },
    retention: { audioDays: 90, textDays: null },
  },
  pro: {
    id: 'pro', name: 'Pro', price: { month: 8, year: 72 },
    tagline: 'Everything, including live translation',
    limits: {
      recordingsPerDay: null,
      maxRecordingSec: 4 * H,
      recordingSecPerMonth: 50 * H, // fair use
      aiTranscriptionSecPerMonth: 50 * H,
      aiNotesPerMonth: null,
      translationCharsPerMonth: 15 * 60 * 900, // ≈ 15 hours of speech (~900 characters per spoken minute)
    },
    features: { aiTranscription: true, translation: true, exports: ['txt', 'md', 'srt', 'vtt'] },
    retention: { audioDays: 365, textDays: null },
  },
};
export const CHARS_PER_MIN = 900;
export const WARN_DAYS = 7;
const DAY = 86400_000;

export const planOf = (u) => PLANS[u?.plan] || PLANS.free;
export const can = (u, feature) => !!planOf(u).features[feature];

export function monthWindow(t = now()) {
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

// ---------- usage ledger (deleting a recording does not refund usage) ----------
export function recordUsage(userId, kind, amount) {
  if (amount > 0) db.prepare('INSERT INTO usage_events (user_id, kind, amount, created_at) VALUES (?, ?, ?, ?)').run(userId, kind, Math.round(amount), now());
}
const sumSince = (userId, kind, since) =>
  db.prepare('SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n, MIN(created_at) AS first FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ?').get(userId, kind, since);

export function usageOf(user) {
  const plan = planOf(user);
  const L = plan.limits;
  const { start, end } = monthWindow();
  const day = sumSince(user.id, 'recording', now() - DAY);
  const rec = sumSince(user.id, 'recording', start);
  const ai = sumSince(user.id, 'ai_transcription', start);
  const notes = sumSince(user.id, 'ai_notes', start);
  const tr = sumSince(user.id, 'translation_chars', start);
  const recordingsLeftToday = L.recordingsPerDay == null ? null : Math.max(0, L.recordingsPerDay - day.n);
  const recordingSecLeft = Math.max(0, L.recordingSecPerMonth - rec.s);
  let blockedReason = null, nextRecordingAt = null;
  if (recordingsLeftToday === 0) {
    nextRecordingAt = day.first + DAY;
    blockedReason = `The ${plan.name} plan allows ${L.recordingsPerDay} recording every 24 hours.`;
  } else if (recordingSecLeft < 60) {
    nextRecordingAt = end;
    blockedReason = `You have used this month's ${Math.round(L.recordingSecPerMonth / 60)} recording minutes.`;
  }
  return {
    plan: plan.id, periodStart: start, periodEnd: end,
    recording: {
      canRecord: !blockedReason, blockedReason, nextRecordingAt,
      todayCount: day.n, perDay: L.recordingsPerDay, leftToday: recordingsLeftToday,
      usedSec: rec.s, limitSec: L.recordingSecPerMonth, leftSec: recordingSecLeft,
      maxRecordingSec: L.maxRecordingSec,
      allowedSec: Math.min(L.maxRecordingSec, recordingSecLeft),
    },
    aiTranscription: { usedSec: ai.s, limitSec: L.aiTranscriptionSecPerMonth, leftSec: Math.max(0, L.aiTranscriptionSecPerMonth - ai.s) },
    aiNotes: { used: notes.n, limit: L.aiNotesPerMonth, left: L.aiNotesPerMonth == null ? null : Math.max(0, L.aiNotesPerMonth - notes.n) },
    translation: {
      enabled: plan.features.translation, usedChars: tr.s, limitChars: L.translationCharsPerMonth,
      leftChars: Math.max(0, L.translationCharsPerMonth - tr.s),
      usedMin: Math.round(tr.s / CHARS_PER_MIN), limitMin: Math.round(L.translationCharsPerMonth / CHARS_PER_MIN),
    },
  };
}

export class LimitError extends Error {
  constructor(message, code = 'limit_reached', extra = {}) { super(message); this.status = 402; this.code = code; this.extra = extra; }
}
export const sendLimit = (res, e) => res.status(402).json({ error: e.message, code: e.code, ...e.extra });

const fmtMin = (s) => { const h = Math.round((s / 3600) * 10) / 10; return s > 3600 ? `${h} hours` : `${Math.round(s / 60)} minutes`; };

/** Checks whether a new recording of `durationSec` may be saved. */
export function checkRecording(user, durationSec) {
  const u = usageOf(user), plan = planOf(user);
  if (!u.recording.canRecord) throw new LimitError(`${u.recording.blockedReason} Upgrade for unlimited recording.`, 'limit_reached', { nextRecordingAt: u.recording.nextRecordingAt });
  const grace = 90;
  if (durationSec > plan.limits.maxRecordingSec + grace) throw new LimitError(`Recordings on the ${plan.name} plan can be up to ${fmtMin(plan.limits.maxRecordingSec)}. Upgrade to save longer recordings.`);
  if (durationSec > u.recording.leftSec + grace) throw new LimitError(`This recording is longer than the ${fmtMin(u.recording.leftSec)} you have left this month. Upgrade to save it.`);
}

export function checkAiNotes(user) {
  const u = usageOf(user);
  if (u.aiNotes.left === 0) throw new LimitError(`You've used your ${u.aiNotes.limit} AI notes for this month. Upgrade to Plus for unlimited notes and minutes.`);
}

export function aiTranscriptionAllowed(user, durationSec) {
  if (!can(user, 'aiTranscription')) return false;
  return usageOf(user).aiTranscription.leftSec >= Math.min(durationSec || 0, 60) && usageOf(user).aiTranscription.leftSec > 0;
}

export function checkTranslation(user, chars) {
  if (!can(user, 'translation')) throw new LimitError('Live translation is part of the Pro plan. Upgrade in Account → Plans.', 'upgrade_required', { feature: 'translation' });
  const u = usageOf(user);
  if (u.translation.leftChars < chars) throw new LimitError(`You've used this month's ${u.translation.limitMin / 60} hours of translation. It resets on ${new Date(u.periodEnd).toDateString()}.`);
}

export function checkExport(user, format) {
  if (!planOf(user).features.exports.includes(format)) throw new LimitError(`.${format} export is available on Plus and Pro. Free plan exports plain text.`, 'upgrade_required', { feature: 'export' });
}

// ---------- retention ----------
/** When this recording's audio / text will be deleted on the owner's current plan (null = never). */
export function expiryOf(rec, user) {
  const plan = planOf(user);
  // after a downgrade, give at least WARN_DAYS before anything is removed
  const floor = (user.plan_changed_at || 0) + WARN_DAYS * DAY;
  const at = (days) => (days == null ? null : Math.max(rec.created_at + days * DAY, floor));
  return { audioDeleteAt: rec.audio_file ? at(plan.retention.audioDays) : null, textDeleteAt: at(plan.retention.textDays) };
}

export function publicPlans() {
  return Object.values(PLANS).map((p) => ({
    id: p.id, name: p.name, tagline: p.tagline, price: p.price, currency: config.billing.currency,
    limits: p.limits, features: p.features, retention: p.retention,
  }));
}
