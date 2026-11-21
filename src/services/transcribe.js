// Server-side transcription with speaker diarization (who spoke when).
import fs from 'node:fs';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assemblyAI(file, { language }) {
  const key = config.transcription.assemblyKey;
  const up = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST', headers: { authorization: key, 'content-type': 'application/octet-stream' },
    body: fs.createReadStream(file), duplex: 'half',
  });
  if (!up.ok) throw new Error(`AssemblyAI upload failed: ${up.status}`);
  const { upload_url } = await up.json();
  const body = { audio_url: upload_url, speaker_labels: true, punctuate: true, format_text: true };
  if (language && language !== 'auto') body.language_code = language.split('-')[0];
  else body.language_detection = true;
  const job = await (await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  if (!job.id) throw new Error(`AssemblyAI error: ${job.error || 'no job id'}`);
  for (let i = 0; i < 2000; i++) {
    await sleep(i < 10 ? 3000 : 8000);
    const r = await (await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, { headers: { authorization: key } })).json();
    if (r.status === 'completed') {
      const utt = r.utterances?.length ? r.utterances : [{ speaker: 'A', start: 0, end: (r.audio_duration || 0) * 1000, text: r.text || '' }];
      return { language: r.language_code, segments: utt.map((u) => ({ start: u.start / 1000, end: u.end / 1000, text: u.text, speaker: u.speaker })) };
    }
    if (r.status === 'error') throw new Error(`AssemblyAI: ${r.error}`);
  }
  throw new Error('AssemblyAI timed out');
}

async function deepgram(file, { language, mime }) {
  const q = new URLSearchParams({ model: 'nova-3', diarize: 'true', punctuate: 'true', smart_format: 'true', utterances: 'true', paragraphs: 'true' });
  if (language && language !== 'auto') q.set('language', language); else q.set('detect_language', 'true');
  const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
    method: 'POST', headers: { Authorization: `Token ${config.transcription.deepgramKey}`, 'Content-Type': mime || 'audio/webm' },
    body: fs.createReadStream(file), duplex: 'half',
  });
  if (!res.ok) throw new Error(`Deepgram failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const r = await res.json();
  const utt = r.results?.utterances || [];
  return {
    language: r.results?.channels?.[0]?.detected_language,
    segments: utt.map((u) => ({ start: u.start, end: u.end, text: u.transcript, speaker: String.fromCharCode(65 + (u.speaker ?? 0)) })),
  };
}

export const transcriptionAvailable = () => !!config.transcription.provider;

export async function transcribeFile(file, opts) {
  const p = config.transcription.provider;
  if (p === 'assemblyai') return assemblyAI(file, opts);
  if (p === 'deepgram') return deepgram(file, opts);
  throw new Error('No transcription provider configured');
}
