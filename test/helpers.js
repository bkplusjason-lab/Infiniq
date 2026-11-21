import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infiniq-test-'));
Object.assign(process.env, {
  SKIP_DOTENV: '1', DATA_DIR: dir, DB_FILE: path.join(dir, 'test.db'), NODE_ENV: 'test', DEV_LOGIN: 'true',
  GOOGLE_CLIENT_ID: '', FACEBOOK_APP_ID: '', WHATSAPP_TOKEN: '', SMTP_HOST: '', TRANSCRIPTION_PROVIDER: '',
  ASSEMBLYAI_API_KEY: '', DEEPGRAM_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
});

export async function startServer() {
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, dir };
}

export class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  async req(method, p, body, extraHeaders = {}) {
    const headers = { 'X-Requested-With': 'infiniq', ...extraHeaders };
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + p, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const [k, v] = kv.split('=');
      if (/Expires=Thu, 01 Jan 1970/.test(c) || v === '') delete this.cookies[k]; else this.cookies[k] = v;
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p, b) { return this.req('DELETE', p, b); }
}

export function outbox(dir) {
  const d = path.join(dir, 'outbox');
  return fs.readdirSync(d).sort().map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
}
export const lastCode = (dir, to) => {
  const m = outbox(dir).filter((x) => x.to === to && /\b\d{6}\b/.test(x.subject || x.text)).pop();
  return m && (m.subject || m.text).match(/\b\d{6}\b/)[0];
};
