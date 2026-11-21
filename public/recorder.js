// Microphone recorder with live captions, pitch tracking, pause/resume,
// bookmarks and crash-safe chunk backup in IndexedDB.
import { PITCH_STEP, decimate, estimateF0 } from './pitch.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const liveCaptionsSupported = !!SR;
export const recordingSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

// ---------- IndexedDB backup ----------
const DB_NAME = 'infiniq-backup';
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('chunks', { autoIncrement: true }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(store, mode, fn) {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
      t.oncomplete = () => resolve(out?.result ?? out); t.onerror = () => reject(t.error);
    });
  } catch { return null; }
}
export const backup = {
  add: (blob) => tx('chunks', 'readwrite', (s) => s.add(blob)),
  setMeta: (m) => tx('meta', 'readwrite', (s) => s.put(m, 'current')),
  async load() {
    const meta = await tx('meta', 'readonly', (s) => s.get('current'));
    if (!meta) return null;
    const chunks = await tx('chunks', 'readonly', (s) => s.getAll());
    if (!chunks?.length) return null;
    return { meta, blob: new Blob(chunks, { type: meta.mime || 'audio/webm' }) };
  },
  clear: () => Promise.all([tx('chunks', 'readwrite', (s) => s.clear()), tx('meta', 'readwrite', (s) => s.clear())]),
};

export class Recorder extends EventTarget {
  constructor({ language = 'en-US', captions = true } = {}) {
    super();
    this.language = language;
    this.captions = captions && liveCaptionsSupported;
    this.segments = [];
    this.bookmarks = [];
    this.pitch = [];
    this.chunks = [];
    this.state = 'idle';
    this.elapsedBefore = 0;
    this.startedAt = 0;
    this.interim = '';
  }

  get elapsed() { return this.elapsedBefore + (this.state === 'recording' ? (performance.now() - this.startedAt) / 1000 : 0); }

  async start(meta = {}) {
    this.extraMeta = meta;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.mime = pickMime();
    this.mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);
    this.mime = this.mr.mimeType || this.mime || 'audio/webm';
    await backup.clear();
    await backup.setMeta({ ...meta, mime: this.mime, startedAt: Date.now() });
    this.mr.ondataavailable = (e) => { if (e.data?.size) { this.chunks.push(e.data); backup.add(e.data); } };
    this.mr.start(1000);

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => this.#tick(), PITCH_STEP * 1000);

    this.state = 'recording';
    this.startedAt = performance.now();
    this.#startRecognition();
    this.#wakeLock();
    this.#emit('state');
  }

  #tick() {
    if (this.state !== 'recording') return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) peak = Math.max(peak, Math.abs(this.buf[i]));
    const { data, sr } = decimate(this.buf, this.ctx.sampleRate);
    const idx = Math.floor(this.elapsed / PITCH_STEP);
    const f0 = Math.round(estimateF0(data, sr));
    while (this.pitch.length < idx) this.pitch.push(0);
    this.pitch[idx] = f0;
    this.#emit('level', { level: Math.min(1, peak * 1.4), f0 });
    if (idx % 50 === 0) backup.setMeta({ ...this.#metaSnapshot() });
  }

  #metaSnapshot() {
    return { mime: this.mime, segments: this.segments, bookmarks: this.bookmarks, duration: this.elapsed, pitch: { step: PITCH_STEP, f0: this.pitch } , language: this.language, ...this.extraMeta };
  }

  #startRecognition() {
    if (!this.captions) return;
    const rec = new SR();
    rec.lang = this.language;
    rec.continuous = true;
    rec.interimResults = true;
    let segStart = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (segStart == null) segStart = Math.max(0, this.elapsed - 1.5);
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            this.segments.push({ start: segStart, end: this.elapsed, text: text[0].toUpperCase() + text.slice(1), speaker: null });
            this.#emit('segment');
          }
          segStart = null;
        } else interim += r[0].transcript;
      }
      this.interim = interim;
      this.#emit('interim', { text: interim });
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.captions = false; this.#emit('captions-off', { reason: e.error }); }
    };
    // Browsers stop recognition after silences; restart while recording.
    rec.onend = () => { if (this.state === 'recording' && this.captions) setTimeout(() => { try { rec.start(); } catch {} }, 250); };
    try { rec.start(); } catch {}
    this.recognition = rec;
  }

  async #wakeLock() {
    try { this.lock = await navigator.wakeLock?.request('screen'); } catch {}
  }

  pause() {
    if (this.state !== 'recording') return;
    this.elapsedBefore = this.elapsed;
    this.state = 'paused';
    this.mr.pause();
    try { this.recognition?.stop(); } catch {}
    this.#emit('state');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mr.resume();
    this.state = 'recording';
    this.startedAt = performance.now();
    if (this.captions) { try { this.recognition?.start(); } catch {} }
    this.#wakeLock();
    this.#emit('state');
  }

  addBookmark(label) {
    const b = { t: Math.max(0, this.elapsed - 2), label: label || `Bookmark ${this.bookmarks.length + 1}` };
    this.bookmarks.push(b);
    this.#emit('bookmark');
    return b;
  }

  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') return null;
    const duration = this.elapsed;
    this.elapsedBefore = duration;
    this.state = 'stopped';
    clearInterval(this.timer);
    try { this.recognition?.stop(); } catch {}
    if (this.interim.trim()) this.segments.push({ start: Math.max(0, duration - 3), end: duration, text: this.interim.trim(), speaker: null });
    const done = new Promise((r) => { this.mr.onstop = r; });
    if (this.mr.state !== 'inactive') this.mr.stop();
    await done;
    this.stream.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    try { await this.lock?.release(); } catch {}
    this.#emit('state');
    return {
      blob: new Blob(this.chunks, { type: this.mime }), mime: this.mime, duration,
      segments: this.segments, bookmarks: this.bookmarks, pitch: { step: PITCH_STEP, f0: this.pitch },
    };
  }

  cancel() {
    clearInterval(this.timer);
    this.state = 'stopped';
    try { this.recognition?.stop(); } catch {}
    try { this.mr?.stop(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    backup.clear();
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
