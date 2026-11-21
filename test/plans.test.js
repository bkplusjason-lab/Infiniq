import fs from 'node:fs';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, lastCode, outbox } from './helpers.js';

let srv, db, runRetention, plans;
before(async () => {
  srv = await startServer();
  ({ db } = await import('../src/db.js'));
  ({ runRetention } = await import('../src/services/retention.js'));
  plans = await import('../src/services/plans.js');
});
after(() => srv.server.close());

async function signIn(email) {
  const c = new Client(srv.base);
  await c.post('/api/auth/dev', { provider: 'google', email, name: 'P' });
  await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, email) });
  c.id = (await c.get('/api/me')).data.user.id;
  return c;
}
async function upload(c, durationSec, title = 'Rec') {
  const form = new FormData();
  form.append('title', title);
  form.append('durationSec', String(durationSec));
  form.append('segments', JSON.stringify([{ start: 0, end: 2, text: 'Hello.' }]));
  form.append('audio', new Blob([new Uint8Array(1024)], { type: 'audio/webm' }), 'a.webm');
  return c.req('POST', '/api/recordings', form);
}
const DAY = 86400_000;
const audioDir = () => path.join(srv.dir, 'audio');

test('Free: one recording per 24 hours, and deleting it does not reset the limit', async () => {
  const c = await signIn('free1@example.com');
  let u = (await c.get('/api/me')).data.plan;
  assert.equal(u.plan, 'free');
  assert.equal(u.recording.canRecord, true);
  assert.equal(u.recording.allowedSec, 3600);
  const r1 = await upload(c, 600);
  assert.equal(r1.status, 201);
  u = (await c.get('/api/me')).data.plan;
  assert.equal(u.recording.canRecord, false);
  assert.ok(u.recording.nextRecordingAt > Date.now() + 23 * 3600_000);
  const r2 = await upload(c, 60);
  assert.equal(r2.status, 402);
  assert.equal(r2.data.code, 'limit_reached');
  assert.ok(r2.data.nextRecordingAt);
  await c.del(`/api/recordings/${r1.data.recording.id}`);
  assert.equal((await upload(c, 60)).status, 402, 'deleting must not refund usage');
  // uploaded file of a rejected recording is not kept
  const files = fs.readdirSync(path.join(audioDir(), c.id));
  assert.equal(files.length, 0);
  // 24 hours later it works again
  db.prepare('UPDATE usage_events SET created_at = created_at - ? WHERE user_id = ?').run(DAY + 1000, c.id);
  assert.equal((await upload(c, 60)).status, 201);
});

test('Free: recordings over 60 minutes and over the monthly 300 minutes are refused', async () => {
  const c = await signIn('free2@example.com');
  const long = await upload(c, 65 * 60);
  assert.equal(long.status, 402);
  assert.match(long.data.error, /60 minutes/);
  // simulate 290 minutes used earlier this month (on different days)
  db.prepare('INSERT INTO usage_events (user_id, kind, amount, created_at) VALUES (?, ?, ?, ?)').run(c.id, 'recording', 290 * 60, plans.monthWindow().start + 1000);
  const u = (await c.get('/api/me')).data.plan;
  assert.equal(u.recording.leftSec, 10 * 60);
  assert.equal(u.recording.allowedSec, 10 * 60);
  assert.equal((await upload(c, 20 * 60)).status, 402);
  assert.equal((await upload(c, 9 * 60)).status, 201);
});

test('Plus: unlimited daily recordings, longer recordings, all exports', async () => {
  const c = await signIn('plus1@example.com');
  await c.post('/api/billing/test/subscribe', { plan: 'plus', interval: 'month' });
  for (let i = 0; i < 3; i++) assert.equal((await upload(c, 2 * 3600)).status, 201);
  const u = (await c.get('/api/me')).data.plan;
  assert.equal(u.recording.perDay, null);
  assert.equal(u.recording.usedSec, 6 * 3600);
  assert.equal(u.aiNotes.limit, null);
  assert.equal((await upload(c, 5 * 3600)).status, 402, '4 hour cap per recording');
});

test('Free: 3 AI notes per month (checked against the usage ledger)', async () => {
  const c = await signIn('free3@example.com');
  const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(c.id);
  for (let i = 0; i < 3; i++) { plans.checkAiNotes(user()); plans.recordUsage(c.id, 'ai_notes', 1); }
  assert.throws(() => plans.checkAiNotes(user()), /3 AI notes/);
  await c.post('/api/billing/test/subscribe', { plan: 'plus' });
  assert.doesNotThrow(() => plans.checkAiNotes(user()));
});

test('Retention: warns 7 days ahead, deletes Free audio after 30 days and everything after 12 months', async () => {
  const c = await signIn('keep@example.com');
  const r = (await upload(c, 60, 'Old sermon')).data.recording;
  assert.ok(r.audioDeleteAt > Date.now() + 29 * DAY);
  assert.ok(r.textDeleteAt > Date.now() + 364 * DAY);
  const file = path.join(audioDir(), db.prepare('SELECT audio_file FROM recordings WHERE id = ?').get(r.id).audio_file);
  assert.ok(fs.existsSync(file));
  const age = (days) => db.prepare('UPDATE recordings SET created_at = ? WHERE id = ?').run(Date.now() - days * DAY, r.id);
  db.prepare('UPDATE users SET plan_changed_at = NULL WHERE id = ?').run(c.id);

  age(25); // 5 days before audio deletion -> warning email, nothing deleted
  let s = await runRetention();
  assert.equal(s.warned >= 1, true);
  assert.ok(fs.existsSync(file));
  const mail = outbox(srv.dir).filter((m) => m.to === 'keep@example.com' && /deleted soon/.test(m.subject));
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /Old sermon/);
  await runRetention();
  assert.equal(outbox(srv.dir).filter((m) => m.to === 'keep@example.com' && /deleted soon/.test(m.subject)).length, 1, 'warn only once');

  age(31); // audio expired
  await runRetention();
  assert.ok(!fs.existsSync(file));
  const after = (await c.get(`/api/recordings/${r.id}`)).data.recording;
  assert.equal(after.hasAudio, false);
  assert.ok(after.audioDeletedAt);
  assert.equal(after.segments.length, 1, 'transcript kept');

  age(366); // text expired
  await runRetention();
  assert.equal((await c.get(`/api/recordings/${r.id}`)).status, 404);
});

test('Retention: upgrading keeps data longer; downgrading gives 7 days grace', async () => {
  const c = await signIn('grace@example.com');
  await c.post('/api/billing/test/subscribe', { plan: 'pro', interval: 'month' });
  const r = (await upload(c, 60)).data.recording;
  assert.equal(r.textDeleteAt, null, 'Pro keeps notes and transcripts');
  db.prepare('UPDATE recordings SET created_at = ? WHERE id = ?').run(Date.now() - 100 * DAY, r.id);
  await runRetention();
  assert.equal((await c.get(`/api/recordings/${r.id}`)).data.recording.hasAudio, true, 'Pro keeps audio 12 months');
  await c.post('/api/billing/test/subscribe', { plan: 'free' });
  const d = (await c.get(`/api/recordings/${r.id}`)).data.recording;
  assert.ok(d.audioDeleteAt > Date.now() + 6 * DAY, 'grace period after downgrade');
  await runRetention();
  assert.equal((await c.get(`/api/recordings/${r.id}`)).data.recording.hasAudio, true);
});
