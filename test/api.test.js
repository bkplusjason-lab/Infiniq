import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, outbox, lastCode } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.server.close());

async function signIn(email, name = 'Test User') {
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/dev', { provider: 'google', email, name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const code = lastCode(srv.dir, email);
  const v = await c.post('/api/auth/otp/verify', { code });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return c;
}

test('config is public and reports dev mode', async () => {
  const r = await new Client(srv.base).get('/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.devLogin, true);
  assert.equal(r.data.providers.google, false);
});

test('registration sends welcome email once, and every login requires a fresh OTP', async () => {
  const email = 'grace@example.com';
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/dev', { provider: 'google', email, name: 'Grace' });
  assert.equal(r.status, 200);
  assert.equal(r.data.otp.channel, 'email');
  assert.match(r.data.otp.destination, /^gr\*+@example\.com$/);

  const welcome = outbox(srv.dir).filter((m) => m.to === email && /Welcome/.test(m.subject));
  assert.equal(welcome.length, 1);

  // pending session cannot access recordings
  assert.equal((await c.get('/api/recordings')).status, 401);
  assert.equal((await c.get('/api/auth/status')).data.state, 'otp_required');

  // wrong code
  const bad = await c.post('/api/auth/otp/verify', { code: '000000' === lastCode(srv.dir, email) ? '111111' : '000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Incorrect code/);

  const ok = await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, email) });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/auth/status')).data.state, 'signed_in');
  assert.equal((await c.get('/api/recordings')).status, 200);

  // code can't be reused
  assert.equal((await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, email) })).status, 400);

  // logout + login again: new OTP, no second welcome email
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/recordings')).status, 401);
  const before = lastCode(srv.dir, email);
  await c.post('/api/auth/dev', { provider: 'google', email });
  assert.equal((await c.get('/api/auth/status')).data.state, 'otp_required');
  const fresh = lastCode(srv.dir, email);
  assert.equal(outbox(srv.dir).filter((m) => m.to === email && /Welcome/.test(m.subject)).length, 1);
  assert.equal((await c.post('/api/auth/otp/verify', { code: fresh })).status, 200);
  assert.ok(before);
});

test('OTP locks after 5 wrong attempts', async () => {
  const email = 'lock@example.com';
  const c = new Client(srv.base);
  await c.post('/api/auth/dev', { provider: 'facebook', email });
  const good = lastCode(srv.dir, email);
  const wrong = good === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await c.post('/api/auth/otp/verify', { code: wrong });
  const r = await c.post('/api/auth/otp/verify', { code: good });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Too many/);
});

test('WhatsApp login sends the code via WhatsApp, then asks for an email', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.post('/api/auth/whatsapp', { phone: 'abc' })).status, 400);
  const r = await c.post('/api/auth/whatsapp', { phone: '+65 9123 4567' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.otp.channel, 'whatsapp');
  assert.equal(r.data.needsEmail, true);
  const msg = outbox(srv.dir).filter((m) => m.channel === 'whatsapp' && m.to === '+6591234567').pop();
  const code = msg.text.match(/\d{6}/)[0];
  const v = await c.post('/api/auth/otp/verify', { code });
  assert.equal(v.status, 200);
  assert.equal(v.data.needsEmail, true);

  const e = await c.post('/api/auth/email', { email: 'wa.user@example.com' });
  assert.equal(e.status, 200);
  await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, 'wa.user@example.com') });
  const st = await c.get('/api/auth/status');
  assert.equal(st.data.user.email, 'wa.user@example.com');
  assert.equal(st.data.user.phone, '+6591234567');
  assert.ok(outbox(srv.dir).some((m) => m.to === 'wa.user@example.com' && /Welcome/.test(m.subject)));
});

test('WhatsApp account merges into an existing account with the same email', async () => {
  const existing = await signIn('merge@example.com', 'Merge Me');
  const me = (await existing.get('/api/me')).data.user;
  const c = new Client(srv.base);
  await c.post('/api/auth/whatsapp', { phone: '+60123456789' });
  await c.post('/api/auth/otp/verify', { code: outbox(srv.dir).filter((m) => m.to === '+60123456789').pop().text.match(/\d{6}/)[0] });
  await c.post('/api/auth/email', { email: 'merge@example.com' });
  const v = await c.post('/api/auth/otp/verify', { code: lastCode(srv.dir, 'merge@example.com') });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.id, me.id);
  assert.deepEqual(v.data.user.providers.sort(), ['google', 'whatsapp']);
});

test('requests without the CSRF header are rejected', async () => {
  const r = await fetch(srv.base + '/api/auth/logout', { method: 'POST' });
  assert.equal(r.status, 403);
});

test('recordings: upload, voice analysis, edit, search, export, delete, isolation', async () => {
  const c = await signIn('pastor@example.com', 'Pastor');
  // pitch track: 0-10s male (~115 Hz), 10-20s female (~215 Hz)
  const f0 = Array.from({ length: 200 }, (_, i) => (i < 100 ? 110 + (i % 10) : 210 + (i % 10)));
  const segments = [
    { start: 0.5, end: 4.5, text: 'Good morning church, open your Bibles to John 3:16.' },
    { start: 5, end: 9.5, text: 'For God so loved the world.' },
    { start: 10.5, end: 14, text: 'Amen, thank you pastor.' },
    { start: 15, end: 19.5, text: 'Let us pray together.' },
  ];
  const form = new FormData();
  form.append('title', 'Sunday Service');
  form.append('kind', 'sermon');
  form.append('durationSec', '20');
  form.append('segments', JSON.stringify(segments));
  form.append('pitch', JSON.stringify({ step: 0.1, f0 }));
  form.append('bookmarks', JSON.stringify([{ t: 5, label: 'Key verse' }]));
  form.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'rec.webm');
  const up = await c.req('POST', '/api/recordings', form);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const rec = up.data.recording;
  assert.equal(rec.status, 'ready');
  const sp = Object.entries(rec.speakers);
  assert.equal(sp.length, 2, JSON.stringify(rec.speakers));
  const voices = sp.map(([, s]) => s.voice).sort();
  assert.deepEqual(voices, ['female', 'male']);
  assert.equal(rec.segments[0].speaker, rec.segments[1].speaker);
  assert.notEqual(rec.segments[1].speaker, rec.segments[2].speaker);

  // rename + correct voice
  const [maleId] = sp.find(([, s]) => s.voice === 'male');
  const p = await c.patch(`/api/recordings/${rec.id}`, { speakers: { [maleId]: { name: 'Pastor John', voice: 'male' } }, tags: ['faith', 'john'], notes: 'Great sermon' });
  assert.equal(p.status, 200);
  assert.equal(p.data.recording.speakers[maleId].name, 'Pastor John');
  assert.equal(p.data.recording.speakers[maleId].manualVoice, true);
  assert.deepEqual(p.data.recording.tags, ['faith', 'john']);

  // audio served
  const a = await c.req('GET', `/api/recordings/${rec.id}/audio`);
  assert.equal(a.status, 200);

  // search transcript text
  assert.equal((await c.get('/api/recordings?q=loved')).data.recordings.length, 1);
  assert.equal((await c.get('/api/recordings?q=nomatch')).data.recordings.length, 0);
  assert.equal((await c.get('/api/recordings?kind=meeting')).data.recordings.length, 0);

  // export
  const md = await c.get(`/api/recordings/${rec.id}/export?format=md`);
  assert.match(md.data, /\*\*\[0:00\] Pastor John:\*\* Good morning/);
  const srt = await c.get(`/api/recordings/${rec.id}/export?format=srt`);
  assert.match(srt.data, /00:00:00,500 --> 00:00:04,500/);

  // AI notes are disabled without key
  assert.equal((await c.post(`/api/recordings/${rec.id}/notes`)).status, 400);

  // another user cannot see it
  const other = await signIn('other@example.com');
  assert.equal((await other.get(`/api/recordings/${rec.id}`)).status, 404);
  assert.equal((await other.get(`/api/recordings/${rec.id}/audio`)).status, 404);
  assert.equal((await other.get('/api/recordings')).data.recordings.length, 0);

  assert.equal((await c.del(`/api/recordings/${rec.id}`)).status, 200);
  assert.equal((await c.get(`/api/recordings/${rec.id}`)).status, 404);
});

test('account deletion removes the user', async () => {
  const c = await signIn('bye@example.com');
  assert.equal((await c.del('/api/me', { confirm: 'nope' })).status, 400);
  assert.equal((await c.del('/api/me', { confirm: 'DELETE' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});
