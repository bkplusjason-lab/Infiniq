// End-to-end browser test: sign-in with OTP, record from a fake microphone, view and edit.
// Run: npm run test:e2e   (uses the pre-installed Playwright Chromium)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { startServer, lastCode } from './helpers.js';

const shots = process.env.SHOTS_DIR || path.join(process.cwd(), 'test-results');
fs.mkdirSync(shots, { recursive: true });

// A WAV with a voiced 115 Hz "male" tone, then a 220 Hz "female" tone (harmonic-rich, like speech).
function makeWav(file) {
  const sr = 48000, secs = 8, n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = t < secs / 2 ? 115 : 220;
    let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    buf.writeInt16LE(Math.round(v * 0.25 * 32767 / 2), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const { base, server, dir } = await startServer();
const wav = path.join(dir, 'voice.wav'); makeWav(wav);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept('Key point'));

  await page.goto(base);
  await page.waitForSelector('#btn-google');
  await page.screenshot({ path: `${shots}/1-login-mobile.png` });
  await page.click('#btn-google');
  await page.fill('#dev-form [name=name]', 'Grace Tan');
  await page.fill('#dev-form [name=email]', 'grace@example.com');
  await page.click('#dev-form button[type=submit]');
  await page.waitForSelector('#otp-form:not([hidden])');
  await page.screenshot({ path: `${shots}/2-otp-mobile.png` });
  await page.fill('#otp-form [name=code]', lastCode(dir, 'grace@example.com'));
  await page.waitForSelector('text=Your library');
  await page.screenshot({ path: `${shots}/3-library-empty-mobile.png` });

  await page.click('a[href="#/record"] >> nth=0');
  await page.fill('#r-title', 'Sunday Service – Grace');
  await page.selectOption('#r-kind', 'sermon');
  await page.click('#rec-btn');
  await page.waitForTimeout(2500);
  await page.click('#mark-btn');
  await page.waitForFunction(() => /Voice now/.test(document.querySelector('#voice-now').textContent), null, { timeout: 8000 });
  const voice1 = await page.textContent('#voice-now');
  await page.waitForTimeout(4500);
  const voice2 = await page.textContent('#voice-now');
  await page.screenshot({ path: `${shots}/4-recording-mobile.png` });
  console.log('live voice readings:', voice1.trim(), '|', voice2.trim());
  await page.click('#stop-btn');
  await page.waitForSelector('#d-title', { timeout: 15000 });
  assert.equal(await page.inputValue('#d-title'), 'Sunday Service – Grace');
  assert.ok(await page.$('audio#audio'));
  assert.match(await page.textContent('#bookmarks'), /Key point/);
  await page.screenshot({ path: `${shots}/5-detail-mobile.png`, fullPage: true });

  // Free plan: the library shows usage, and a second recording within 24 h is blocked
  await page.goto(`${base}/#/`);
  await page.waitForSelector('.plan-card .usage');
  await page.screenshot({ path: `${shots}/5c-library-free-usage-mobile.png` });
  await page.goto(`${base}/#/record`);
  await page.waitForSelector('text=Recording limit reached');
  await page.screenshot({ path: `${shots}/5d-free-limit-mobile.png` });
  // free export is text only: locked formats open the upgrade pop-up
  await page.goto(`${base}/#/`);
  await page.click('.rec-card >> nth=0');
  await page.click('#export-btn');
  await page.click('[data-locked-export=md]');
  await page.waitForSelector('dialog.upgrade[open]');
  await page.screenshot({ path: `${shots}/5e-upgrade-dialog-mobile.png` });
  await page.click('dialog.upgrade [value=close]');

  // upgrade to Plus on the Plans page (test mode)
  await page.goto(`${base}/#/plans`);
  await page.waitForSelector('[data-plan=plus]');
  await page.screenshot({ path: `${shots}/5f-plans-mobile.png`, fullPage: true });
  await page.click('[data-plan=plus]');
  await page.waitForSelector('.plan-current >> text=Plus');

  // seed a recording with a diarized-style transcript to check the transcript view
  const seededId = await page.evaluate(async () => {
    const f0 = Array.from({ length: 300 }, (_, i) => (i < 150 ? 112 : 215));
    const segs = [
      { start: 1, end: 6, text: 'Good morning everyone. Let us open our Bibles to John chapter 3 verse 16.', speaker: 'A' },
      { start: 6.5, end: 13, text: 'For God so loved the world that he gave his one and only Son.', speaker: 'A' },
      { start: 15.5, end: 21, text: 'Amen. Pastor, could you explain what it means to believe?', speaker: 'B' },
      { start: 22, end: 29, text: 'Great question. To believe is to trust completely, not just to agree.', speaker: 'A' },
    ];
    const fd = new FormData();
    fd.append('title', 'Bible study – John 3'); fd.append('kind', 'lecture'); fd.append('durationSec', '30');
    fd.append('segments', JSON.stringify(segs)); fd.append('pitch', JSON.stringify({ step: 0.1, f0 }));
    const r = await fetch('/api/recordings', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'infiniq' } });
    return (await r.json()).recording.id;
  });
  await page.goto(`${base}/#/r/${seededId}`);
  await page.waitForSelector('.seg');
  assert.equal(await page.locator('.seg.v-male').count(), 3);
  assert.equal(await page.locator('.seg.v-female').count(), 1);
  await page.screenshot({ path: `${shots}/5b-transcript-mobile.png` });

  // desktop layout
  const desk = await browser.newContext({ viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1, storageState: await ctx.storageState() });
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await dp.goto(base + '/#/');
  await dp.waitForSelector('.rec-card');
  await dp.screenshot({ path: `${shots}/6-library-desktop.png` });
  await dp.click('.rec-card >> nth=0');
  await dp.waitForSelector('.seg');
  await dp.screenshot({ path: `${shots}/7-detail-desktop.png` });
  await dp.goto(base + '/#/plans');
  await dp.waitForSelector('.plan-current');
  await dp.screenshot({ path: `${shots}/9-plans-desktop.png` });
  await dp.goto(base + '/#/record');
  await dp.waitForSelector('#rec-btn');
  await dp.screenshot({ path: `${shots}/8-record-desktop.png` });
  const overflow = await dp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const overflowMobile = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow || overflowMobile, false, 'no horizontal scroll');
  assert.deepEqual(errors, []);
  console.log('E2E passed. Screenshots in', shots);
} finally {
  await browser.close();
  server.close();
}
