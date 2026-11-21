// Live Translation add-on (client side): language lists, a speech listener,
// and a queue that sends finished caption lines to the server for translation.

// Languages people can translate INTO (BCP-47 codes).
export const TARGET_LANGS = [
  ['en', 'English'], ['zh-Hans', '中文 (简体) Chinese Simplified'], ['zh-Hant', '中文 (繁體) Chinese Traditional'], ['ja', '日本語 Japanese'],
  ['ko', '한국어 Korean'], ['ms', 'Bahasa Melayu'], ['id', 'Bahasa Indonesia'], ['ta', 'தமிழ் Tamil'], ['hi', 'हिन्दी Hindi'],
  ['th', 'ไทย Thai'], ['vi', 'Tiếng Việt'], ['tl', 'Filipino'], ['my', 'မြန်မာ Burmese'], ['km', 'ខ្មែរ Khmer'], ['bn', 'বাংলা Bengali'],
  ['ur', 'اردو Urdu'], ['ar', 'العربية Arabic'], ['fa', 'فارسی Persian'], ['he', 'עברית Hebrew'], ['tr', 'Türkçe'],
  ['ru', 'Русский'], ['uk', 'Українська'], ['pl', 'Polski'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'],
  ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['sv', 'Svenska'], ['sw', 'Kiswahili'],
];
export const langLabel = (code) => TARGET_LANGS.find(([c]) => c === code)?.[1] || code;

// Spoken languages the browser can recognise (speech-to-text).
export const SPOKEN_LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-SG', 'English (Singapore)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'],
  ['ja-JP', '日本語 Japanese'], ['zh-CN', '中文 普通话 (大陆)'], ['zh-TW', '中文 (台灣)'], ['yue-Hant-HK', '粵語 Cantonese'], ['ko-KR', '한국어 Korean'],
  ['ms-MY', 'Bahasa Melayu'], ['id-ID', 'Bahasa Indonesia'], ['ta-IN', 'தமிழ் Tamil'], ['hi-IN', 'हिन्दी Hindi'], ['th-TH', 'ไทย Thai'],
  ['vi-VN', 'Tiếng Việt'], ['fil-PH', 'Filipino'], ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-BR', 'Português'],
  ['it-IT', 'Italiano'], ['ru-RU', 'Русский'], ['ar-SA', 'العربية'], ['tr-TR', 'Türkçe'], ['nl-NL', 'Nederlands'],
];
/** 'ja-JP' -> 'ja', 'zh-TW' -> 'zh-Hant', 'zh-CN' -> 'zh-Hans' */
export function baseLang(spoken) {
  if (!spoken) return 'auto';
  if (/^zh-(TW|HK)|^yue/.test(spoken)) return 'zh-Hant';
  if (/^zh/.test(spoken)) return 'zh-Hans';
  if (spoken === 'fil-PH') return 'tl';
  return spoken.split('-')[0];
}
/** Best spoken-language code for a target language (used to swap directions in conversation mode). */
export function spokenFor(target) {
  const map = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', tl: 'fil-PH', en: 'en-US' };
  return map[target] || SPOKEN_LANGS.find(([c]) => c.split('-')[0] === target)?.[0] || 'en-US';
}
export const speechLangFor = (target) => ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', tl: 'fil-PH' }[target] || target);

export class UpgradeRequired extends Error {}

/**
 * Translates caption lines in order as they arrive. Lines are batched while a
 * request is in flight so the captions keep up with fast speakers.
 */
export class LiveTranslator extends EventTarget {
  constructor({ target, source = 'auto' }) {
    super();
    this.target = target; this.source = source;
    this.lines = []; // { text, translation, state }
    this.busy = false;
  }

  push(text) {
    const i = this.lines.push({ text, translation: null, state: 'pending' }) - 1;
    this.#pump();
    return i;
  }

  /** Waits (up to timeoutMs) for lines still being translated, e.g. when recording stops. */
  async flush(timeoutMs = 6000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.lines.some((l) => l.state === 'pending' || l.state === 'sending')) await new Promise((r) => setTimeout(r, 200));
  }

  get translations() { return this.lines.map((l) => l.translation || ''); }

  async #pump() {
    if (this.busy) return;
    const batch = this.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.state === 'pending').slice(0, 10);
    if (!batch.length) return;
    this.busy = true;
    batch.forEach(({ l }) => { l.state = 'sending'; });
    const first = batch[0].i;
    const context = this.lines.slice(Math.max(0, first - 4), first).map((l) => l.text);
    try {
      const res = await fetch('/api/translate/live', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'infiniq' },
        body: JSON.stringify({ texts: batch.map(({ l }) => l.text), context, source: this.source, target: this.target }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) { batch.forEach(({ l }) => { l.state = 'failed'; }); this.#emit('locked', { message: data.error }); return; }
      if (!res.ok) throw new Error(data.error || 'Translation failed');
      batch.forEach(({ l, i }, k) => { l.translation = data.translations[k]; l.state = 'done'; this.#emit('translated', { index: i, text: l.translation, demo: data.demo }); });
    } catch (e) {
      batch.forEach(({ l, i }) => { l.retries = (l.retries || 0) + 1; l.state = l.retries > 2 ? 'failed' : 'pending'; if (l.state === 'failed') this.#emit('failed', { index: i }); });
      this.#emit('error', { message: e.message });
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      this.busy = false;
    }
    this.#pump();
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = !!SR;

/** Listens to the microphone and emits finished sentences (no recording). */
export class Listener extends EventTarget {
  constructor(lang) { super(); this.lang = lang; this.on = false; }
  start() {
    if (!SR) throw new Error('Speech recognition is not supported in this browser. Use Chrome, Edge or Safari.');
    this.on = true;
    const rec = new SR();
    rec.lang = this.lang; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { const t = r[0].transcript.trim(); if (t) this.#emit('final', { text: t }); }
        else interim += r[0].transcript;
      }
      this.#emit('interim', { text: interim });
    };
    rec.onerror = (e) => { if (['not-allowed', 'service-not-allowed'].includes(e.error)) { this.on = false; this.#emit('blocked', { error: e.error }); } };
    rec.onend = () => { if (this.on) setTimeout(() => { if (this.on) try { rec.start(); } catch {} }, 200); };
    rec.start();
    this.rec = rec;
  }
  setLang(lang) { this.lang = lang; if (this.rec) { this.rec.lang = lang; try { this.rec.stop(); } catch {} } }
  stop() { this.on = false; try { this.rec?.stop(); } catch {} this.#emit('interim', { text: '' }); }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

/** Reads a translation aloud with the device's built-in voices. */
export function speak(text, target) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = speechLangFor(target);
  const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(u.lang.toLowerCase()));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
