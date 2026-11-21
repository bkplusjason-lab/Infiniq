// Browser test for the Live Translation add-on, using simulated Japanese speech.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, lastCode } from './helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const shots = process.env.SHOTS_DIR || path.join(process.cwd(), 'test-results');
fs.mkdirSync(shots, { recursive: true });

// Fake speech recognition that "hears" Japanese sentences one by one.
const fakeSpeech = () => {
  const lines = ['おはようございます。', '今日はヨハネの福音書3章16節を読みます。', '神は、実に、そのひとり子をお与えになったほどに世を愛された。', '会議の議題は来年の予算です。'];
  class FakeSR {
    constructor() { this.lang = ''; this.n = 0; }
    start() {
      this.timer = setInterval(() => {
        if (this.n >= lines.length) return;
        const text = lines[this.n++];
        const result = Object.assign([{ transcript: text }], { isFinal: true });
        const results = Object.assign([result], {});
        this.onresult?.({ resultIndex: 0, results });
      }, 900);
    }
    stop() { clearInterval(this.timer); setTimeout(() => this.onend?.(), 10); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
};

const { base, server, dir } = await startServer();
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
try {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(fakeSpeech);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base);
  await page.click('#btn-google');
  await page.fill('#dev-form [name=email]', 'kenji@example.com');
  await page.fill('#dev-form [name=name]', 'Kenji');
  await page.click('#dev-form button[type=submit]');
  await page.waitForSelector('#otp-form:not([hidden])');
  await page.fill('#otp-form [name=code]', lastCode(dir, 'kenji@example.com'));
  await page.waitForSelector('text=Your library');

  // locked before paying
  await page.click('a[data-nav=translate]');
  await page.waitForSelector('.upsell');
  await page.screenshot({ path: `${shots}/t1-locked-mobile.png` });

  // upgrade to Pro (test mode)
  await page.click('.upsell a[href="#/plans"]');
  await page.waitForSelector('[data-plan=pro]');
  await page.click('[data-plan=pro]');
  await page.waitForSelector('.plan-current >> text=Pro');
  await page.screenshot({ path: `${shots}/t2-plans-mobile.png`, fullPage: true });

  // live interpreter: Japanese -> English
  await page.click('a[data-nav=translate]');
  await page.waitForSelector('#lt-start');
  await page.selectOption('#lt-src', 'ja-JP');
  await page.selectOption('#lt-dst', 'en');
  await page.click('#lt-start');
  await page.waitForFunction(() => document.querySelectorAll('.lt-item .lt-tr').length >= 3 && ![...document.querySelectorAll('.lt-tr')].some((e) => e.textContent === '…'), null, { timeout: 10000 });
  const firstTr = await page.textContent('.lt-item .lt-tr');
  assert.match(firstTr, /English/);
  await page.screenshot({ path: `${shots}/t3-live-translate-mobile.png` });
  await page.click('#lt-start'); // stop

  // record a "sermon" with live translation on
  await page.click('a[data-nav=record]');
  await page.waitForSelector('#tr-on');
  assert.equal(await page.isChecked('#tr-on'), true);
  await page.selectOption('#r-lang', 'ja-JP');
  await page.fill('#r-title', '日曜礼拝 – 神の愛');
  await page.click('#rec-btn');
  await page.waitForFunction(() => document.querySelectorAll('#live .tr-line').length >= 3 && ![...document.querySelectorAll('#live .tr-line')].some((e) => e.textContent === '…'), null, { timeout: 12000 });
  await page.screenshot({ path: `${shots}/t4-record-translating-mobile.png`, fullPage: true });
  await page.click('#stop-btn');
  await page.waitForSelector('#d-title', { timeout: 15000 });

  // translation tab shows the live translation, then make English notes
  await page.click('[data-tab=translate]');
  await page.waitForSelector('#tr-panel .orig');
  assert.ok((await page.locator('#tr-panel .chip', { hasText: 'live' }).count()) >= 1);
  await page.click('[data-trdo=notes]');
  await page.waitForSelector('#tr-panel .md h2, #tr-panel .md h1');
  await page.screenshot({ path: `${shots}/t5-detail-translation-mobile.png`, fullPage: true });

  // desktop view of the translation tab
  const desk = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: await ctx.storageState() });
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await dp.goto(page.url());
  await dp.waitForSelector('[data-tab=translate]');
  await dp.click('[data-tab=translate]');
  await dp.waitForSelector('#tr-panel .orig');
  await dp.screenshot({ path: `${shots}/t6-detail-translation-desktop.png` });
  await dp.goto(`${base}/#/translate`);
  await dp.click('[data-mode=talk]');
  await dp.screenshot({ path: `${shots}/t7-conversation-desktop.png` });

  for (const p of [page, dp]) assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal scroll');
  assert.deepEqual(errors, []);
  console.log('Translation E2E passed. Screenshots in', shots);
} finally {
  await browser.close();
  server.close();
}
