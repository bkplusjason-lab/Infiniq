// Translation engine for the paid "Live Translation" add-on.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client = null;
const getClient = () => (client ||= new Anthropic());
const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

export const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
export function languageName(code) {
  if (!code || code === 'auto') return 'the original language';
  try { return displayNames.of(code) || code; } catch { return code; }
}
export const translationAvailable = () => !!config.translation.provider;
export const isMock = () => config.translation.provider === 'mock';
export const sourceHash = (segments) => crypto.createHash('sha256').update(segments.map((s) => s.text).join('\n')).digest('hex').slice(0, 16);

const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false,
};

const SYSTEM = `You are a professional interpreter translating spoken content from sermons, lectures, meetings, conversations and songs.
- Translate meaning faithfully and naturally, as a fluent native speaker of the target language would say it. Keep the speaker's tone.
- Speech-recognition output can contain errors or missing punctuation; translate what was most likely said.
- Keep names, scripture references (book chapter:verse), numbers, dates and technical terms accurate. Use the standard rendering of Bible books in the target language.
- If a line is already in the target language, return it unchanged. Never add commentary, notes or explanations.`;

async function callClaude({ system, content, live, json }) {
  const params = {
    model: config.translation.model,
    max_tokens: live ? 4000 : 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: live ? 'low' : 'medium', ...(json ? { format: { type: 'json_schema', schema: SCHEMA } } : {}) },
    system,
    messages: [{ role: 'user', content }],
  };
  const msg = live ? await getClient().beta.messages.create(params) : await getClient().beta.messages.stream(params).finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to translate this content.'), { status: 422 });
  if (msg.stop_reason === 'max_tokens') throw new Error('Translation was cut off; try a shorter piece.');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Translates a list of short texts (caption lines / transcript segments).
 * Returns an array of the same length. `context` = preceding lines (already spoken) for coherence.
 */
export async function translateTexts(texts, { target, source, context = [], live = false }) {
  if (!texts.length) return [];
  if (isMock()) return texts.map((t) => `[${languageName(target)} – demo] ${t}`);
  const out = [];
  const CHUNK = live ? 20 : 60;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    const prev = i === 0 ? context.slice(-4) : texts.slice(Math.max(0, i - 4), i);
    const content = `Translate each line into ${languageName(target)}${source && source !== 'auto' ? ` (spoken language: ${languageName(source)})` : ''}.
Return JSON {"translations": [...]} with exactly ${chunk.length} strings, one per input line, in the same order.
${prev.length ? `\nEarlier context (do not translate):\n${prev.map((t) => `- ${t}`).join('\n')}\n` : ''}
Lines:
${JSON.stringify(chunk)}`;
    const text = await callClaude({ system: SYSTEM, content, live, json: true });
    let arr = [];
    try { arr = JSON.parse(text).translations || []; } catch { arr = []; }
    // never misalign: fall back to the source text for any missing line
    for (let j = 0; j < chunk.length; j++) out.push(typeof arr[j] === 'string' && arr[j].trim() ? arr[j].trim() : chunk[j]);
  }
  return out;
}

/** Translates a Markdown document (e.g. notes or minutes), keeping its structure. */
export async function translateMarkdown(md, { target }) {
  if (!md?.trim()) return '';
  if (isMock()) return `> Demo translation to ${languageName(target)} (no AI key configured)\n\n${md}`;
  const text = await callClaude({
    system: SYSTEM,
    content: `Translate this Markdown document into ${languageName(target)}. Keep all Markdown formatting, headings, tables, list structure and [m:ss] timestamps exactly. Output only the translated Markdown.\n\n<document>\n${md}\n</document>`,
  });
  return text.trim();
}
