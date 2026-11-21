import { Recorder, backup, liveCaptionsSupported, recordingSupported } from './recorder.js';
import { analyseFile } from './pitch.js';
import { renderMarkdown } from './markdown.js';

// ---------------- helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = { sermon: 'Sermon', lecture: 'Lecture', meeting: 'Meeting minutes', other: 'Other' };
const VOICES = { male: 'Male voice', female: 'Female voice', unknown: 'Voice not detected' };
const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-SG', 'English (Singapore)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'],
  ['zh-CN', '中文 (普通话)'], ['zh-TW', '中文 (台灣)'], ['ms-MY', 'Bahasa Melayu'], ['id-ID', 'Bahasa Indonesia'], ['ta-IN', 'தமிழ்'], ['hi-IN', 'हिन्दी'],
  ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-BR', 'Português'], ['ko-KR', '한국어'], ['ja-JP', '日本語'], ['tl-PH', 'Filipino']];

export function fmtTime(t) {
  const s = Math.max(0, Math.floor(t || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const parseTs = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'infiniq', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : form,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { state.auth = { state: 'signed_out' }; go('#/login'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

function uploadWithProgress(form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/recordings');
    x.setRequestHeader('X-Requested-With', 'infiniq');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { const d = JSON.parse(x.responseText || '{}'); x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Upload failed')); };
    x.onerror = () => reject(new Error('Network error while uploading. Your recording is kept on this device; try again.'));
    x.send(form);
  });
}

const state = { config: null, auth: null, recorder: null };
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };

// ---------------- icons ----------------
const ICON = {
  google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1877F2" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4h-3V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25D366" d="M12 0a12 12 0 0 0-10.3 18.1L0 24l6.1-1.6A12 12 0 1 0 12 0z"/><path fill="#fff" d="M17.5 14.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1l-.9 1.2c-.2.2-.3.2-.6.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.1 1.1 0 0 0-.8.4 3.4 3.4 0 0 0-1.1 2.5 5.9 5.9 0 0 0 1.2 3.1 13.5 13.5 0 0 0 5.2 4.6c1.9.8 2.7.9 3.6.7.6-.1 1.8-.7 2-1.4.3-.7.3-1.3.2-1.4-.1-.2-.3-.3-.6-.4z"/></svg>',
};

// ---------------- router ----------------
async function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  if (!state.config) state.config = await api('/api/config');
  if (!state.auth || ['/login', '/otp'].includes(path)) state.auth = await api('/api/auth/status');

  if (state.recorder && state.recorder.state !== 'stopped' && path !== '/record') {
    if (!confirm('A recording is in progress. Leave this page and discard it?')) { history.back(); return; }
    state.recorder.cancel(); state.recorder = null;
  }

  viewAbort();
  const a = state.auth.state;
  if (a === 'signed_out' && path !== '/login') return go('#/login');
  if (a === 'otp_required' && path !== '/otp') return go('#/otp');
  if (a === 'signed_in' && ['/login', '/otp'].includes(path) && !(path === '/otp' && state.auth.needsEmail)) return go('#/');
  if (a === 'signed_in' && state.auth.needsEmail && path !== '/otp') return go('#/otp?addEmail=1');

  const signedIn = a === 'signed_in';
  $('#topbar').hidden = !signedIn;
  $$('.nav a').forEach((l) => l.classList.toggle('active', l.dataset.nav === ({ '/': 'library', '/record': 'record', '/account': 'account' }[path] || (path.startsWith('/r/') ? 'library' : ''))));
  window.scrollTo(0, 0);

  if (path === '/login') return viewLogin(params);
  if (path === '/otp') return viewOtp(params);
  if (path === '/record') return viewRecord();
  if (path === '/account') return viewAccount();
  if (path.startsWith('/r/')) return viewDetail(path.slice(3));
  return viewLibrary();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (state.recorder && ['recording', 'paused'].includes(state.recorder.state)) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- login ----------------
function viewLogin(params) {
  const { providers, devLogin } = state.config;
  const err = params.get('error');
  main.innerHTML = `
  <section class="auth"><div class="auth-card">
    <div class="auth-hero">
      <img src="icon.svg" alt="">
      <h1>Welcome to ${esc(state.config.appName)}</h1>
      <p class="muted">Record, transcribe and take notes of sermons, lectures and meetings.</p>
    </div>
    <div class="card stack">
      ${err ? `<div class="banner err">${esc(err)}</div>` : ''}
      <a class="btn provider" id="btn-google" href="/auth/google">${ICON.google} Continue with Google</a>
      <a class="btn provider" id="btn-facebook" href="/auth/facebook">${ICON.facebook} Continue with Facebook</a>
      <button class="btn provider" id="btn-whatsapp" type="button">${ICON.whatsapp} Continue with WhatsApp</button>
      <form id="wa-form" class="stack" hidden>
        <label class="field"><span>WhatsApp number (with country code)</span>
          <input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+65 9123 4567" required></label>
        <button class="btn primary block" type="submit">Send code to WhatsApp</button>
      </form>
      <form id="dev-form" class="stack" hidden>
        <div class="banner warn"><b>Test mode:</b> <span id="dev-which"></span> sign-in keys are not configured yet, so this simulates it. Codes and emails appear in the <a href="/dev/outbox" target="_blank">dev outbox</a>.</div>
        <label class="field"><span>Name</span><input class="input" name="name" autocomplete="name" placeholder="Jane Tan"></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" placeholder="jane@example.com"></label>
        <button class="btn primary block" type="submit">Continue</button>
      </form>
      <p class="muted small center">By continuing you agree to the Terms of Use and Privacy Policy. A 6-digit code is sent each time you sign in.</p>
    </div>
    ${devLogin ? `<p class="center small"><a href="/dev/outbox" target="_blank">Open dev outbox (test emails &amp; codes)</a></p>` : ''}
  </div></section>`;

  const showDev = (provider) => {
    const f = $('#dev-form'); f.hidden = false; f.dataset.provider = provider;
    $('#dev-which').textContent = provider === 'google' ? 'Google' : 'Facebook';
    $('#wa-form').hidden = true; f.querySelector('[name=name]').focus();
  };
  for (const p of ['google', 'facebook']) {
    if (!providers[p] && devLogin) $(`#btn-${p}`).addEventListener('click', (e) => { e.preventDefault(); showDev(p); });
  }
  if (params.get('dev')) showDev(params.get('dev'));
  $('#btn-whatsapp').addEventListener('click', () => { $('#wa-form').hidden = false; $('#dev-form').hidden = true; $('#wa-form [name=phone]').focus(); });

  $('#wa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try { await api('/api/auth/whatsapp', { method: 'POST', body: { phone: e.target.phone.value } }); go('#/otp'); }
    catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
  $('#dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = e.submitter; btn.disabled = true;
    try {
      await api('/api/auth/dev', { method: 'POST', body: { provider: f.dataset.provider, name: f.name.value.trim(), email: f.email.value.trim() } });
      go('#/otp');
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
}

// ---------------- OTP ----------------
function viewOtp() {
  const a = state.auth;
  const needEmail = a.needsEmail && !a.otp?.destination?.includes('@');
  const verified = a.state === 'signed_in';
  main.innerHTML = `
  <section class="auth"><div class="auth-card">
    <div class="auth-hero"><img src="icon.svg" alt=""><h1 id="otp-title"></h1><p class="muted" id="otp-sub"></p></div>
    <div class="card stack">
      <form id="email-form" class="stack" hidden>
        <label class="field"><span>Email address</span><input class="input" name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
        <button class="btn primary block" type="submit">Send code to my email</button>
      </form>
      <form id="otp-form" class="stack" hidden>
        <label class="field"><span>6-digit code</span>
          <input class="input otp-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required aria-describedby="otp-sub"></label>
        <button class="btn primary block" type="submit">Verify &amp; continue</button>
        <div class="row spread small">
          <button class="btn ghost sm" type="button" id="resend">Resend code</button>
          <button class="btn ghost sm" type="button" id="restart">Use another account</button>
        </div>
      </form>
      ${state.config.devLogin ? `<p class="small center"><a href="/dev/outbox" target="_blank">Open dev outbox to see the code</a></p>` : ''}
    </div>
  </div></section>`;

  const showCode = (otp) => {
    $('#email-form').hidden = true; $('#otp-form').hidden = false;
    $('#otp-title').textContent = 'Enter your code';
    $('#otp-sub').textContent = otp ? `We sent a 6-digit code to your ${otp.channel === 'whatsapp' ? 'WhatsApp' : 'email'} ${otp.destination}. It expires in 10 minutes.` : 'Enter the 6-digit code we sent you.';
    $('#otp-form [name=code]').focus();
  };
  const showEmail = () => {
    $('#email-form').hidden = false; $('#otp-form').hidden = true;
    $('#otp-title').textContent = 'Add your email';
    $('#otp-sub').textContent = 'We need your email address to send your welcome email, sign-in codes and receipts.';
    $('#email-form [name=email]').focus();
  };
  if (needEmail && (verified || !a.otp)) showEmail(); else showCode(a.otp);

  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = e.submitter; btn.disabled = true;
    try { const r = await api('/api/auth/email', { method: 'POST', body: { email: e.target.email.value.trim() } }); showCode(r.otp); }
    catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
  const codeInput = $('#otp-form [name=code]');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); if (codeInput.value.length === 6) $('#otp-form').requestSubmit(); });
  $('#otp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#otp-form button[type=submit]'); btn.disabled = true;
    try {
      const r = await api('/api/auth/otp/verify', { method: 'POST', body: { code: codeInput.value } });
      state.auth = { state: 'signed_in', user: r.user, needsEmail: r.needsEmail };
      if (r.needsEmail) { toast('Signed in. Please add your email.'); showEmail(); }
      else { toast(`Welcome${r.user.name ? ', ' + r.user.name : ''}!`); go('#/'); }
    } catch (err) { toast(err.message, true); codeInput.select(); } finally { btn.disabled = false; }
  });
  let cooldown = 0;
  $('#resend').addEventListener('click', async (e) => {
    if (cooldown) return;
    try {
      const r = await api('/api/auth/otp/resend', { method: 'POST', body: {} }); showCode(r.otp); toast('A new code is on its way.');
      cooldown = 30; const b = e.target;
      const iv = setInterval(() => { b.textContent = --cooldown ? `Resend in ${cooldown}s` : 'Resend code'; if (!cooldown) clearInterval(iv); }, 1000);
    } catch (err) { toast(err.message, true); }
  });
  $('#restart').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); go('#/login'); });
}

// ---------------- library ----------------
async function viewLibrary() {
  main.innerHTML = `<div class="container">
    <div class="row spread"><h1>Your library</h1>
      <div class="row"><label class="btn" for="import-file">⬆ Import audio</label><input id="import-file" type="file" accept="audio/*,video/*" hidden>
      <a class="btn primary" href="#/record">● New recording</a></div></div>
    <div id="recover"></div>
    <div class="stats" id="stats"></div>
    <div class="toolbar">
      <input class="input" id="q" type="search" placeholder="Search titles, transcripts and notes…" aria-label="Search">
      <div class="row" id="kinds">${['', ...Object.keys(KINDS)].map((k) => `<button class="chip ${k ? '' : 'on'}" data-kind="${k}">${k ? KINDS[k] : 'All'}</button>`).join('')}</div>
    </div>
    <div id="list" class="grid"><div class="loading">Loading…</div></div>
  </div>`;
  let kind = '', timer;
  const load = async () => {
    const q = $('#q').value.trim();
    const { recordings } = await api(`/api/recordings?${new URLSearchParams({ q, kind })}`);
    $('#list').innerHTML = recordings.length ? recordings.map((r) => `
      <a class="card rec-card" href="#/r/${r.id}">
        <div class="row small"><span class="chip kind-${r.kind}">${KINDS[r.kind]}</span>
          ${r.status === 'transcribing' ? '<span class="chip">⏳ Transcribing</span>' : ''}${r.status === 'error' ? '<span class="chip">⚠ Needs attention</span>' : ''}
          ${r.hasAiNotes ? '<span class="chip">✨ Notes</span>' : ''}</div>
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.preview || 'No transcript yet.')}</p>
        <div class="row small muted" style="margin-top:8px">${fmtDate(r.createdAt)} · ${fmtTime(r.durationSec)}${r.speakerCount ? ` · ${r.speakerCount} speaker${r.speakerCount > 1 ? 's' : ''}` : ''}</div>
      </a>`).join('') : `<div class="empty card" style="grid-column:1/-1">${q || kind ? 'Nothing matches your search.' : 'No recordings yet. Tap <b>New recording</b> to capture your first sermon, lecture or meeting.'}</div>`;
  };
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    kind = b.dataset.kind; $$('#kinds .chip').forEach((c) => c.classList.toggle('on', c === b)); load();
  });
  $('#import-file').addEventListener('change', (e) => e.target.files[0] && importFile(e.target.files[0]));
  load().catch((e) => toast(e.message, true));
  api('/api/me').then(({ usage }) => {
    $('#stats').innerHTML = `<div class="card stat"><b>${usage.recordings}</b><span class="small muted">Recordings</span></div>
      <div class="card stat"><b>${usage.minutes}</b><span class="small muted">Minutes</span></div>
      <div class="card stat"><b>${(usage.bytes / 1048576).toFixed(0)} MB</b><span class="small muted">Storage</span></div>`;
  }).catch(() => {});
  const saved = await backup.load();
  if (saved && saved.blob.size > 0) {
    $('#recover').innerHTML = `<div class="banner warn row spread" style="margin-bottom:14px"><span>An unsaved recording (${fmtTime(saved.meta.duration)}) was found on this device.</span>
      <span class="row"><button class="btn sm primary" id="rec-save">Save it</button><button class="btn sm" id="rec-drop">Discard</button></span></div>`;
    $('#rec-save').onclick = () => saveRecording({ ...saved.meta, blob: saved.blob, title: saved.meta.title || 'Recovered recording' });
    $('#rec-drop').onclick = async () => { if (confirm('Discard the unsaved recording?')) { await backup.clear(); $('#recover').innerHTML = ''; } };
  }
}

async function importFile(file) {
  main.innerHTML = `<div class="container"><div class="card stack center"><h2>Importing “${esc(file.name)}”</h2>
    <p class="muted" id="imp-msg">Analysing voices…</p><div class="meter"><i id="imp-bar"></i></div></div></div>`;
  let analysis = { duration: null, pitch: null };
  try {
    if (file.size < 400 * 1048576) analysis = await analyseFile(file, (p) => { $('#imp-bar').style.width = `${Math.round(p * 50)}%`; });
  } catch (e) { console.warn('could not analyse file', e); }
  const kind = /meeting/i.test(file.name) ? 'meeting' : /lecture|class/i.test(file.name) ? 'lecture' : /sermon|service|church/i.test(file.name) ? 'sermon' : 'other';
  await saveRecording({ blob: file, mime: file.type, title: file.name.replace(/\.[^.]+$/, ''), kind, duration: analysis.duration, pitch: analysis.pitch, segments: [], bookmarks: [], fromImport: true });
}

async function saveRecording(r) {
  const form = new FormData();
  const ext = (r.mime || '').includes('mp4') ? 'm4a' : (r.mime || '').includes('ogg') ? 'ogg' : 'webm';
  form.append('title', r.title || '');
  form.append('kind', r.kind || 'other');
  form.append('language', r.language || '');
  form.append('tags', r.tags || '');
  form.append('notes', r.notes || '');
  form.append('durationSec', String(r.duration || ''));
  form.append('segments', JSON.stringify(r.segments || []));
  form.append('bookmarks', JSON.stringify(r.bookmarks || []));
  if (r.pitch) form.append('pitch', JSON.stringify(r.pitch));
  form.append('audio', r.blob, r.blob.name || `recording.${ext}`);
  main.innerHTML = `<div class="container"><div class="card stack center"><h2>Saving your recording…</h2>
    <p class="muted">Please keep this page open.</p><div class="meter"><i id="up-bar"></i></div></div></div>`;
  try {
    const { recording } = await uploadWithProgress(form, (p) => { const b = $('#up-bar'); if (b) b.style.width = `${Math.round((r.fromImport ? 50 : 0) + p * (r.fromImport ? 50 : 100))}%`; });
    await backup.clear();
    toast('Saved.');
    go(`#/r/${recording.id}`);
  } catch (e) {
    toast(e.message, true);
    main.innerHTML = `<div class="container"><div class="card stack center"><h2>Could not save</h2><p>${esc(e.message)}</p>
      <button class="btn primary" id="retry">Try again</button></div></div>`;
    $('#retry').onclick = () => saveRecording(r);
  }
}

// ---------------- record ----------------
function viewRecord() {
  if (!recordingSupported) {
    main.innerHTML = `<div class="container"><div class="card"><h1>Recording not supported</h1><p>This browser can't record audio. Please use a recent version of Chrome, Edge, Safari or Firefox. You can still <a href="#/">import an audio file</a>.</p></div></div>`;
    return;
  }
  const prefs = JSON.parse(localStorage.getItem('rec-prefs') || '{}');
  const defLang = prefs.language || (LANGS.find(([c]) => c === navigator.language)?.[0]) || 'en-US';
  main.innerHTML = `<div class="container"><div class="rec-layout">
    <div class="card stack rec-panel">
      <label class="field"><span>Title</span><input class="input" id="r-title" placeholder="e.g. Sunday service – Grace that saves"></label>
      <div class="row">
        <label class="field grow"><span>Type</span><select class="input" id="r-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${prefs.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field grow"><span>Language</span><select class="input" id="r-lang">${LANGS.map(([c, n]) => `<option value="${c}" ${c === defLang ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="timer" id="timer" aria-live="off">0:00</div>
      <div class="meter" aria-hidden="true"><i id="meter"></i></div>
      <div class="voice-now small muted" id="voice-now">${liveCaptionsSupported ? 'Live captions will appear as you speak.' : 'Live captions are not available in this browser; the transcript will be made after you stop' + (state.config.serverTranscription ? '.' : ' (requires a transcription service on the server).')}</div>
      <button class="big-rec" id="rec-btn" aria-label="Start recording">REC</button>
      <div class="row" style="justify-content:center">
        <button class="btn" id="pause-btn" disabled>⏸ Pause</button>
        <button class="btn" id="mark-btn" disabled>🔖 Bookmark</button>
        <button class="btn primary" id="stop-btn" disabled>■ Stop &amp; save</button>
      </div>
      <p class="small muted center">Tip: place your device close to the speaker. Keep this tab open; the screen will stay awake.</p>
    </div>
    <div class="stack">
      <div class="card"><h2>Live transcript</h2><div class="live" id="live"><p class="muted">Press <b>REC</b> to start.</p></div></div>
      <div class="card"><h2>My notes</h2><textarea class="input" id="r-notes" placeholder="Type your own notes while you listen…"></textarea>
        <div id="marks" class="small"></div></div>
    </div>
  </div></div>`;

  const rec = new Recorder({ language: $('#r-lang').value });
  state.recorder = rec;
  const live = $('#live');
  const renderLive = (interim = '') => {
    live.innerHTML = rec.segments.map((s) => `<p><span class="muted small">${fmtTime(s.start)}</span> ${esc(s.text)}</p>`).join('') +
      (interim ? `<p class="interim">${esc(interim)}</p>` : '') || '<p class="muted">Listening…</p>';
    live.scrollTop = live.scrollHeight;
  };
  rec.addEventListener('segment', () => renderLive());
  rec.addEventListener('interim', (e) => renderLive(e.detail.text));
  rec.addEventListener('captions-off', () => { $('#voice-now').textContent = 'Live captions were blocked by the browser. Audio is still being recorded.'; });
  let voiceHist = [];
  rec.addEventListener('level', (e) => {
    $('#meter').style.width = `${Math.round(e.detail.level * 100)}%`;
    $('#timer').textContent = fmtTime(rec.elapsed);
    if (e.detail.f0) voiceHist.push(e.detail.f0);
    if (voiceHist.length > 25) voiceHist = voiceHist.slice(-25);
    if (voiceHist.length >= 10) {
      const m = [...voiceHist].sort((a, b) => a - b)[voiceHist.length >> 1];
      $('#voice-now').innerHTML = `Voice now: <span class="chip ${m < 167 ? 'male' : 'female'}">${m < 167 ? 'Male' : 'Female'} · ${Math.round(m)} Hz</span>`;
    }
  });
  rec.addEventListener('bookmark', () => {
    $('#marks').innerHTML = '<h3 style="margin-top:12px">Bookmarks</h3>' + rec.bookmarks.map((b) => `<div>🔖 ${fmtTime(b.t)} – ${esc(b.label)}</div>`).join('');
  });

  const btn = $('#rec-btn');
  btn.onclick = async () => {
    if (rec.state === 'idle') {
      try {
        rec.language = $('#r-lang').value;
        localStorage.setItem('rec-prefs', JSON.stringify({ kind: $('#r-kind').value, language: rec.language }));
        await rec.start({ title: $('#r-title').value, kind: $('#r-kind').value });
        btn.classList.add('recording'); btn.textContent = '●'; btn.setAttribute('aria-label', 'Recording');
        $('#pause-btn').disabled = $('#mark-btn').disabled = $('#stop-btn').disabled = false;
        $('#r-lang').disabled = true;
        renderLive();
      } catch (e) {
        toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser settings.' : `Could not start: ${e.message}`, true);
      }
    } else if (rec.state === 'paused') $('#pause-btn').click();
  };
  $('#pause-btn').onclick = () => {
    if (rec.state === 'recording') { rec.pause(); $('#pause-btn').textContent = '▶ Resume'; btn.classList.remove('recording'); btn.textContent = 'PAUSED'; }
    else if (rec.state === 'paused') { rec.resume(); $('#pause-btn').textContent = '⏸ Pause'; btn.classList.add('recording'); btn.textContent = '●'; }
  };
  $('#mark-btn').onclick = () => { const label = prompt('Bookmark label (optional):', ''); if (label !== null) rec.addBookmark(label.trim()); };
  $('#stop-btn').onclick = async () => {
    $('#stop-btn').disabled = true;
    const out = await rec.stop();
    state.recorder = null;
    await saveRecording({ ...out, title: $('#r-title').value.trim(), kind: $('#r-kind').value, language: rec.language, notes: $('#r-notes').value });
  };
}

// ---------------- detail ----------------
async function viewDetail(id) {
  main.innerHTML = '<div class="loading">Loading…</div>';
  let rec;
  try { rec = (await api(`/api/recordings/${id}`)).recording; } catch (e) { main.innerHTML = `<div class="container"><div class="card">${esc(e.message)}</div></div>`; return; }
  const cfg = state.config;
  let tab = 'transcript';

  main.innerHTML = `<div class="container">
    <div class="detail-head">
      <div class="grow">
        <input class="title-input" id="d-title" value="${esc(rec.title)}" aria-label="Title">
        <div class="row small muted">
          <select class="chip kind-${rec.kind}" id="d-kind" aria-label="Type">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === rec.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span>${fmtDate(rec.createdAt)}</span><span>· ${fmtTime(rec.durationSec)}</span>
          <span id="d-source"></span>
        </div>
      </div>
      <div class="row">
        <div class="menu"><button class="btn" id="export-btn" aria-haspopup="true">⬇ Export</button>
          <div class="menu-list" id="export-menu" hidden>
            <a href="/api/recordings/${rec.id}/export?format=md">Markdown (.md)</a>
            <a href="/api/recordings/${rec.id}/export?format=txt">Plain text (.txt)</a>
            <a href="/api/recordings/${rec.id}/export?format=srt">Subtitles (.srt)</a>
            <a href="/api/recordings/${rec.id}/export?format=vtt">Subtitles (.vtt)</a>
            ${rec.hasAudio ? `<a href="/api/recordings/${rec.id}/audio" download>Audio file</a>` : ''}
            <button type="button" id="print-btn">Print / Save as PDF</button>
            <button type="button" id="share-btn">Share…</button>
          </div></div>
        <button class="btn danger" id="del-btn">Delete</button>
      </div>
    </div>
    <div id="status-banner"></div>
    ${rec.hasAudio ? `<div class="card player"><audio id="audio" controls preload="metadata" src="/api/recordings/${rec.id}/audio"></audio>
      <div class="row small" style="margin-top:6px"><span class="muted">Speed</span>${[0.75, 1, 1.25, 1.5, 2].map((s) => `<button class="chip ${s === 1 ? 'on' : ''}" data-rate="${s}">${s}×</button>`).join('')}
      <button class="chip" data-skip="-10">⟲ 10s</button><button class="chip" data-skip="10">10s ⟳</button></div></div>` : ''}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="transcript" aria-selected="true">Transcript</button>
      <button role="tab" data-tab="ai" aria-selected="false">✨ AI notes</button>
      <button role="tab" data-tab="notes" aria-selected="false">My notes</button>
    </div>
    <div class="detail-layout">
      <div>
        <section role="tabpanel" data-panel="transcript" class="card">
          <div class="row spread"><input class="input grow" id="t-search" type="search" placeholder="Find in transcript…" style="max-width:320px">
            <span class="small muted">Click a time to play · double-click text to edit</span></div>
          <div id="segments" style="margin-top:10px"></div>
        </section>
        <section role="tabpanel" data-panel="ai" class="card" hidden>
          <div class="row spread"><h2 style="margin:0">AI notes</h2>
            <div class="row"><button class="btn sm" id="ai-edit" hidden>Edit</button><button class="btn sm primary" id="ai-gen">✨ Generate</button></div></div>
          <div id="ai-body" class="md" style="margin-top:12px"></div>
        </section>
        <section role="tabpanel" data-panel="notes" class="card" hidden>
          <h2>My notes</h2>
          <textarea class="input" id="my-notes" style="min-height:320px" placeholder="Your own notes. Markdown supported (# heading, - bullet, **bold**).">${esc(rec.notes)}</textarea>
          <p class="small muted" id="notes-status">Saved automatically.</p>
        </section>
      </div>
      <aside class="detail-side stack">
        <div class="card"><h2>Speakers</h2><div id="speakers"></div>
          <p class="small muted">Voice type is estimated from pitch and may be wrong for some voices. You can correct it.</p></div>
        <div class="card"><h2>Tags</h2><input class="input" id="d-tags" placeholder="e.g. faith, finance, Q3" value="${esc(rec.tags.join(', '))}"></div>
        <div class="card" id="bm-card"><h2>Bookmarks</h2><div id="bookmarks"></div></div>
        <div class="card stack"><h2>Transcription</h2><div class="small muted" id="tx-info"></div>
          <button class="btn sm" id="retx" ${rec.hasAudio && cfg.serverTranscription ? '' : 'hidden'}>↻ Re-transcribe with speaker detection</button></div>
      </aside>
    </div>
  </div>`;

  const audio = $('#audio');
  const seek = (t) => { if (!audio) return; audio.currentTime = t; audio.play().catch(() => {}); };
  const save = async (patch) => { try { rec = (await api(`/api/recordings/${rec.id}`, { method: 'PATCH', body: patch })).recording; return true; } catch (e) { toast(e.message, true); return false; } };

  const renderStatus = () => {
    $('#status-banner').innerHTML = rec.status === 'transcribing'
      ? '<div class="banner" style="margin:12px 0">⏳ Transcribing and separating speakers… This page will update automatically.</div>'
      : rec.status === 'error' ? `<div class="banner err" style="margin:12px 0">${esc(rec.error)}</div>` : '';
    $('#d-source').textContent = rec.transcriptSource ? `· ${rec.transcriptSource === 'browser' ? 'Live captions' : 'AI transcription'}` : '';
    $('#tx-info').textContent = rec.transcriptSource === 'browser'
      ? 'This transcript came from live browser captions. Speakers were grouped by voice pitch, which is approximate.'
      : rec.transcriptSource ? 'Transcribed with AI speaker detection (diarization).' : 'No transcript yet.';
  };

  const voiceChip = (v) => `<span class="chip ${v}">${v === 'male' ? '♂' : v === 'female' ? '♀' : '?'} ${VOICES[v] || VOICES.unknown}</span>`;
  const renderSpeakers = () => {
    const ids = Object.keys(rec.speakers);
    $('#speakers').innerHTML = ids.length ? ids.map((sid) => {
      const s = rec.speakers[sid]; const n = rec.segments.filter((g) => g.speaker === sid).length;
      return `<div class="speaker" data-sid="${esc(sid)}">
        <input class="input sp-name" value="${esc(s.name)}" aria-label="Speaker name">
        <select class="input sp-voice" aria-label="Voice type">${['male', 'female', 'unknown'].map((v) => `<option value="${v}" ${s.voice === v ? 'selected' : ''}>${v === 'male' ? '♂ Male' : v === 'female' ? '♀ Female' : '? Unknown'}</option>`).join('')}</select>
        <div class="small muted" style="grid-column:1/-1">${voiceChip(s.voice)} ${s.f0 ? `· ${s.f0} Hz` : ''}${s.confidence && !s.manualVoice ? ` · ${Math.round(s.confidence * 100)}% sure` : s.manualVoice ? ' · set by you' : ''} · ${n} part${n === 1 ? '' : 's'}</div>
      </div>`;
    }).join('') : '<p class="muted small">No speakers yet.</p>';
  };
  $('#speakers').addEventListener('change', async (e) => {
    const row = e.target.closest('.speaker'); if (!row) return;
    const sid = row.dataset.sid;
    const patch = e.target.classList.contains('sp-name') ? { name: e.target.value } : { voice: e.target.value };
    if (await save({ speakers: { [sid]: patch } })) { renderSpeakers(); renderSegments(); }
  });

  const renderSegments = () => {
    const q = $('#t-search').value.trim().toLowerCase();
    const segs = rec.segments.map((s, i) => ({ ...s, i })).filter((s) => !q || s.text.toLowerCase().includes(q) || (rec.speakers[s.speaker]?.name || '').toLowerCase().includes(q));
    $('#segments').innerHTML = segs.length ? segs.map((s) => {
      const sp = rec.speakers[s.speaker] || { name: 'Speaker', voice: 'unknown' };
      return `<div class="seg v-${sp.voice}" data-i="${s.i}" data-start="${s.start}" data-end="${s.end}">
        <button class="ts" data-seek="${s.start}">${fmtTime(s.start)}</button>
        <button class="who ${sp.voice}" data-who title="Change speaker">${esc(sp.name)}</button>
        <div class="text" data-text>${esc(s.text)}</div></div>`;
    }).join('') : `<p class="muted">${q ? 'No matches.' : rec.status === 'transcribing' ? 'Transcript in progress…' : 'No transcript for this recording.' + (rec.hasAudio && cfg.serverTranscription ? ' Use “Re-transcribe” to create one.' : '')}</p>`;
  };
  $('#t-search').addEventListener('input', renderSegments);
  $('#segments').addEventListener('click', (e) => {
    const t = e.target.closest('[data-seek]'); if (t) return seek(Number(t.dataset.seek));
    const w = e.target.closest('[data-who]');
    if (w) {
      const seg = w.closest('.seg'); const i = Number(seg.dataset.i);
      const sel = document.createElement('select'); sel.className = 'input'; sel.style.minHeight = '34px';
      sel.innerHTML = Object.entries(rec.speakers).map(([sid, s]) => `<option value="${esc(sid)}" ${rec.segments[i].speaker === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('') + '<option value="__new">+ New speaker</option>';
      w.replaceWith(sel); sel.focus();
      const done = async () => {
        let v = sel.value;
        if (v === '__new') { v = String(Object.keys(rec.speakers).filter((k) => /^\d+$|^[A-Z]$/.test(k)).length + 1) + 'n' + Date.now().toString(36).slice(-3); }
        if (v !== rec.segments[i].speaker) {
          const segments = rec.segments.map((s, j) => (j === i ? { ...s, speaker: v } : s));
          const speakers = rec.speakers[v] ? {} : { [v]: { name: `Speaker ${Object.keys(rec.speakers).length + 1}` } };
          await save({ segments, speakers });
          renderSpeakers();
        }
        renderSegments();
      };
      sel.addEventListener('change', done); sel.addEventListener('blur', () => setTimeout(() => sel.isConnected && renderSegments(), 150));
    }
  });
  $('#segments').addEventListener('dblclick', (e) => {
    const el = e.target.closest('[data-text]'); if (!el) return;
    el.contentEditable = 'true'; el.focus();
    const i = Number(el.closest('.seg').dataset.i);
    const finish = async () => {
      el.contentEditable = 'false';
      const text = el.textContent.trim();
      if (text && text !== rec.segments[i].text) { const segments = rec.segments.map((s, j) => (j === i ? { ...s, text } : s)); if (await save({ segments })) toast('Transcript updated.'); }
    };
    el.addEventListener('blur', finish, { once: true });
    el.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); el.blur(); } if (k.key === 'Escape') { el.textContent = rec.segments[i].text; el.blur(); } });
  });

  if (audio) {
    let last = -1;
    audio.addEventListener('timeupdate', () => {
      const t = audio.currentTime;
      const cur = $$('.seg', $('#segments')).find((s) => t >= Number(s.dataset.start) && t < Number(s.dataset.end) + 0.3);
      const idx = cur ? Number(cur.dataset.i) : -1;
      if (idx === last) return;
      last = idx;
      $$('.seg.current').forEach((s) => s.classList.remove('current'));
      if (cur) { cur.classList.add('current'); if (!audio.paused && tab === 'transcript') cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });
    $('.player').addEventListener('click', (e) => {
      const r = e.target.closest('[data-rate]'); if (r) { audio.playbackRate = Number(r.dataset.rate); $$('[data-rate]').forEach((c) => c.classList.toggle('on', c === r)); }
      const k = e.target.closest('[data-skip]'); if (k) audio.currentTime = Math.max(0, audio.currentTime + Number(k.dataset.skip));
    });
  }

  const renderBookmarks = () => {
    $('#bookmarks').innerHTML = rec.bookmarks.length ? rec.bookmarks.map((b) => `<div><button class="ts-link" data-ts="${fmtTime(b.t)}">${fmtTime(b.t)}</button> ${esc(b.label)}</div>`).join('') : '<p class="small muted">None. Use 🔖 while recording to mark key moments.</p>';
  };
  document.addEventListener('click', (e) => { const l = e.target.closest('.ts-link'); if (l && main.contains(l)) seek(parseTs(l.dataset.ts)); }, { signal: viewAbort.current });

  const renderAi = () => {
    $('#ai-body').innerHTML = rec.aiNotes ? renderMarkdown(rec.aiNotes)
      : `<p class="muted">${cfg.aiNotes ? `Generate ${rec.kind === 'meeting' ? 'formal meeting minutes with decisions and action items' : rec.kind === 'sermon' ? 'sermon notes with scriptures, main points and application' : rec.kind === 'lecture' ? 'study notes with key concepts and review questions' : 'a summary and key points'} from the transcript.` : 'AI notes are not set up on this server yet (the administrator needs to add an Anthropic API key).'}</p>`;
    $('#ai-gen').textContent = rec.aiNotes ? '↻ Regenerate' : '✨ Generate';
    $('#ai-gen').disabled = !cfg.aiNotes || !rec.segments.length;
    $('#ai-edit').hidden = !rec.aiNotes;
  };
  $('#ai-gen').onclick = async () => {
    if (rec.aiNotes && !confirm('Replace the current AI notes?')) return;
    const b = $('#ai-gen'); b.disabled = true; b.textContent = 'Writing notes…';
    $('#ai-body').innerHTML = '<p class="muted">✨ Reading the transcript and writing your notes. This can take up to a minute for long recordings…</p>';
    try { rec = (await api(`/api/recordings/${rec.id}/notes`, { method: 'POST', body: {} })).recording; toast('Notes ready.'); } catch (e) { toast(e.message, true); }
    renderAi();
  };
  $('#ai-edit').onclick = () => {
    $('#ai-body').innerHTML = `<textarea class="input" id="ai-text" style="min-height:400px">${esc(rec.aiNotes)}</textarea><div class="row" style="margin-top:8px"><button class="btn primary sm" id="ai-save">Save</button><button class="btn sm" id="ai-cancel">Cancel</button></div>`;
    $('#ai-save').onclick = async () => { if (await save({ aiNotes: $('#ai-text').value })) renderAi(); };
    $('#ai-cancel').onclick = renderAi;
  };

  $$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => {
    tab = t.dataset.tab;
    $$('.tabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    $$('[role=tabpanel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  }));

  let notesTimer;
  $('#my-notes').addEventListener('input', () => {
    $('#notes-status').textContent = 'Saving…'; clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => { if (await save({ notes: $('#my-notes').value })) $('#notes-status').textContent = 'Saved automatically.'; }, 800);
  });
  $('#d-title').addEventListener('change', (e) => save({ title: e.target.value }));
  $('#d-kind').addEventListener('change', async (e) => { if (await save({ kind: e.target.value })) { e.target.className = `chip kind-${rec.kind}`; renderAi(); } });
  $('#d-tags').addEventListener('change', (e) => save({ tags: e.target.value.split(',') }));
  $('#export-btn').onclick = (e) => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; };
  document.addEventListener('click', () => { const m = $('#export-menu'); if (m) m.hidden = true; }, { signal: viewAbort.current });
  $('#print-btn').onclick = () => window.print();
  $('#share-btn').onclick = async () => {
    const text = `${rec.title}\n\n${rec.aiNotes || rec.segments.map((s) => `${rec.speakers[s.speaker]?.name || ''}: ${s.text}`).join('\n')}`;
    try { if (navigator.share) await navigator.share({ title: rec.title, text }); else { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); } } catch {}
  };
  $('#del-btn').onclick = async () => {
    if (!confirm('Delete this recording, its audio, transcript and notes? This cannot be undone.')) return;
    await api(`/api/recordings/${rec.id}`, { method: 'DELETE' }); toast('Deleted.'); go('#/');
  };
  $('#retx').onclick = async () => {
    if (rec.segments.length && !confirm('Replace the current transcript with a new AI transcription? Your speaker names will be reset.')) return;
    try { rec = (await api(`/api/recordings/${rec.id}/transcribe`, { method: 'POST', body: {} })).recording; renderAll(); poll(); } catch (e) { toast(e.message, true); }
  };

  const renderAll = () => { renderStatus(); renderSpeakers(); renderSegments(); renderBookmarks(); renderAi(); };
  renderAll();
  const poll = () => {
    if (rec.status !== 'transcribing') return;
    setTimeout(async () => {
      if (!location.hash.includes(rec.id)) return;
      try { rec = (await api(`/api/recordings/${rec.id}`)).recording; } catch { return; }
      if (rec.status !== 'transcribing') { renderAll(); toast(rec.status === 'ready' ? 'Transcript ready.' : 'Transcription failed.', rec.status !== 'ready'); } else poll();
    }, 5000);
  };
  poll();
}

// per-view AbortController so document-level listeners are cleaned up when navigating
function viewAbort() {
  viewAbort.ctrl?.abort();
  viewAbort.ctrl = new AbortController();
  viewAbort.current = viewAbort.ctrl.signal;
  return viewAbort.current;
}

// ---------------- account ----------------
async function viewAccount() {
  const { user, usage } = await api('/api/me');
  const names = { google: 'Google', facebook: 'Facebook', whatsapp: 'WhatsApp' };
  main.innerHTML = `<div class="container" style="max-width:720px">
    <h1>Account</h1>
    <div class="card stack">
      <div class="row">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="" width="56" height="56" style="border-radius:50%">` : ''}
        <div class="grow"><b>${esc(user.name || 'No name')}</b><div class="small muted">${esc(user.email || '')}${user.phone ? ` · ${esc(user.phone)}` : ''}</div></div></div>
      <form id="name-form" class="row"><input class="input grow" name="name" value="${esc(user.name || '')}" placeholder="Your name" aria-label="Your name"><button class="btn">Save</button></form>
      <div class="small">Signed in with: ${user.providers.map((p) => `<span class="chip">${names[p] || p}</span>`).join(' ')}</div>
    </div>
    <div class="card stack" style="margin-top:16px">
      <h2>Plan</h2>
      <div class="row spread"><span><span class="chip on">Free beta</span> All features are free while we test.</span></div>
      <div class="small muted">${usage.recordings} recordings · ${usage.minutes} minutes · ${(usage.bytes / 1048576).toFixed(1)} MB stored</div>
    </div>
    <div class="card stack" style="margin-top:16px">
      <h2>Security</h2>
      <p class="small muted">Each new sign-in requires a 6-digit code sent to your ${user.email ? 'email' : 'WhatsApp'}. You stay signed in on this device for a limited time.</p>
      <button class="btn" id="logout">Sign out</button>
    </div>
    <div class="card stack" style="margin-top:16px">
      <h2>Delete account</h2>
      <p class="small muted">Permanently deletes your account, recordings, transcripts and notes.</p>
      <button class="btn danger" id="delete-acct">Delete my account</button>
    </div>
  </div>`;
  $('#name-form').onsubmit = async (e) => { e.preventDefault(); await api('/api/me', { method: 'PATCH', body: { name: e.target.name.value } }); toast('Saved.'); viewAccount(); };
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); state.auth = null; go('#/login'); };
  $('#delete-acct').onclick = async () => {
    const c = prompt('This cannot be undone. Type DELETE to confirm.');
    if (c !== 'DELETE') return;
    await api('/api/me', { method: 'DELETE', body: { confirm: 'DELETE' } }); state.auth = null; go('#/login');
  };
}

route().catch((e) => { main.innerHTML = `<div class="container"><div class="card">Could not load: ${esc(e.message)}</div></div>`; });
