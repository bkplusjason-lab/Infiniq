// Development "outbox": when no real email/WhatsApp provider is configured,
// messages are saved here so you can test the full flow at /dev/outbox.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const dir = path.join(config.dataDir, 'outbox');

export function saveToOutbox(msg) {
  const entry = { ...msg, at: new Date().toISOString() };
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  console.log(`[outbox] ${msg.channel} to ${msg.to}: ${msg.subject || msg.text}`);
  return entry;
}

export function listOutbox(limit = 50) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
