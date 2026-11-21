import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, lastCode } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.server.close());

async function signIn(email) {
  const c = new Client(srv.base);
  await c.post('/api/auth/dev', { provider: 'google', email, name: 'T' });
  await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, email) });
  return c;
}
async function upload(c, extra = {}) {
  const form = new FormData();
  form.append('durationSec', '6');
  form.append('title', '日曜礼拝');
  form.append('kind', 'sermon');
  form.append('language', 'ja-JP');
  form.append('notes', '恵みについて');
  form.append('segments', JSON.stringify([{ start: 0, end: 3, text: 'おはようございます。' }, { start: 3, end: 6, text: '神は愛です。' }]));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const r = await c.req('POST', '/api/recordings', form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.recording;
}

test('config exposes translation in demo mode', async () => {
  const r = await new Client(srv.base).get('/api/config');
  assert.equal(r.data.translation, true);
  assert.equal(r.data.translationDemo, true);
  assert.equal(r.data.billingTestMode, true);
});

test('translation is locked (402) for Free and Plus users', async () => {
  const c = await signIn('free@example.com');
  const live = await c.post('/api/translate/live', { texts: ['こんにちは'], source: 'ja', target: 'en' });
  assert.equal(live.status, 402);
  assert.equal(live.data.code, 'upgrade_required');
  const rec = await upload(c);
  assert.equal((await c.post(`/api/recordings/${rec.id}/translations`, { lang: 'en', what: 'transcript' })).status, 402);
  assert.equal((await c.get(`/api/recordings/${rec.id}/export?format=md&lang=en`)).status, 402);
  // Plus does not include translation either; live translations sent with an upload are ignored
  await c.post('/api/billing/test/subscribe', { plan: 'plus' });
  assert.equal((await c.post('/api/translate/live', { texts: ['x'], target: 'en' })).status, 402);
  const rec2 = await upload(c, { liveTranslation: JSON.stringify({ lang: 'en', texts: ['a', 'b'] }) });
  assert.deepEqual((await c.get(`/api/recordings/${rec2.id}/translations`)).data.translations, []);
});

test('preferred language can be set and validated', async () => {
  const c = await signIn('pref@example.com');
  assert.equal((await c.get('/api/me')).data.user.preferredLang, 'en');
  assert.equal((await c.patch('/api/me', { preferredLang: 'zh-Hans' })).data.user.preferredLang, 'zh-Hans');
  assert.equal((await c.patch('/api/me', { preferredLang: '<script>' })).status, 400);
});

test('Pro user: live translate, translate transcript/notes, export, then downgrade', async () => {
  const c = await signIn('paid@example.com');
  const plans = await c.get('/api/billing/plans');
  assert.deepEqual(plans.data.plans.map((p) => [p.id, p.price.month, p.price.year]), [['free', 0, 0], ['plus', 4, 36], ['pro', 8, 72]]);
  assert.equal(plans.data.current.plan, 'free');
  const act = await c.post('/api/billing/test/subscribe', { plan: 'pro', interval: 'year' });
  assert.equal(act.data.user.plan, 'pro');
  assert.equal(act.data.user.planInterval, 'year');
  assert.equal(act.data.user.features.translation, true);

  const live = await c.post('/api/translate/live', { texts: ['おはよう', '神は愛です'], source: 'ja', target: 'en', context: [] });
  assert.equal(live.status, 200);
  assert.equal(live.data.translations.length, 2);
  assert.match(live.data.translations[0], /English/);
  assert.equal((await c.post('/api/translate/live', { texts: [], target: 'en' })).status, 400);
  assert.equal((await c.post('/api/translate/live', { texts: ['x'], target: 'bad lang' })).status, 400);

  // live translation captured during recording is stored
  const rec = await upload(c, { liveTranslation: JSON.stringify({ lang: 'en', texts: ['Good morning.', 'God is love.'] }) });
  let list = (await c.get(`/api/recordings/${rec.id}/translations`)).data.translations;
  assert.equal(list.length, 1);
  assert.equal(list[0].origin, 'live');
  assert.deepEqual(list[0].segments, ['Good morning.', 'God is love.']);
  assert.equal(list[0].stale, false);

  const md = await c.get(`/api/recordings/${rec.id}/export?format=md&lang=en`);
  assert.match(md.data, /God is love\./);

  // editing the transcript marks the translation stale
  await c.patch(`/api/recordings/${rec.id}`, { segments: [{ start: 0, end: 3, text: 'おはようございます!' }, { start: 3, end: 6, text: '神は愛です。' }] });
  list = (await c.get(`/api/recordings/${rec.id}/translations`)).data.translations;
  assert.equal(list[0].stale, true);

  // re-translate + notes + my notes into Japanese -> English and into Malay
  const t1 = await c.post(`/api/recordings/${rec.id}/translations`, { lang: 'en', what: 'transcript' });
  assert.equal(t1.status, 200);
  assert.equal(t1.data.translation.stale, false);
  assert.equal(t1.data.translation.segments.length, 2);
  const t2 = await c.post(`/api/recordings/${rec.id}/translations`, { lang: 'ms', what: 'notes' });
  assert.equal(t2.status, 200);
  assert.match(t2.data.translation.aiNotes, /Malay/);
  const t3 = await c.post(`/api/recordings/${rec.id}/translations`, { lang: 'ms', what: 'mynotes' });
  assert.match(t3.data.translation.myNotes, /恵みについて/);
  assert.equal((await c.get(`/api/recordings/${rec.id}/translations`)).data.translations.length, 2);

  // other users cannot read translations
  const other = await signIn('other2@example.com');
  assert.equal((await other.get(`/api/recordings/${rec.id}/translations`)).status, 404);

  // translation usage is metered
  const usage = (await c.get('/api/billing/plans')).data.usage.translation;
  assert.ok(usage.usedChars > 0);
  assert.equal(usage.limitMin, 15 * 60);

  // downgrading to Free locks it again
  await c.post('/api/billing/test/subscribe', { plan: 'free' });
  assert.equal((await c.post('/api/translate/live', { texts: ['x'], target: 'en' })).status, 402);
});
