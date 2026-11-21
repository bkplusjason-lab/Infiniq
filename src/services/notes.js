// AI-generated structured notes (sermon notes, lecture notes, meeting minutes) using Claude.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client = null;
const getClient = () => (client ||= new Anthropic());

const fmt = (t) => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

const GUIDES = {
  sermon: `This is a SERMON. Produce sermon notes with these sections:
## Summary (3-5 sentences)
## Key Scriptures (every Bible reference mentioned, with the point it supported)
## Main Points (numbered, each with 1-3 supporting bullets and a timestamp)
## Memorable Quotes (short verbatim quotes with speaker and timestamp)
## Practical Application / Reflection Questions
## Prayer Points (if any were given)`,
  lecture: `This is a LECTURE or class. Produce study notes with these sections:
## Summary
## Key Concepts & Definitions
## Detailed Notes (organised by topic, with timestamps)
## Examples & Formulas mentioned
## Questions raised / Things to review
## Possible Exam / Quiz Questions (5, with short answers)`,
  meeting: `This is a MEETING. Produce formal meeting minutes with these sections:
## Meeting Overview (purpose, date if mentioned, duration)
## Attendees (speakers as named in the transcript)
## Agenda / Topics Discussed (each with a short summary and timestamp)
## Decisions Made
## Action Items (table: Action | Owner | Due date if mentioned)
## Open Issues / Follow-ups`,
  other: `Produce clear notes with these sections:
## Summary
## Key Points (with timestamps)
## Notable Quotes
## Action Items or Follow-ups (if any)`,
};

export const notesAvailable = () => config.claude.enabled;

export async function generateNotes(rec, segments, speakers, bookmarks, { outputLanguage } = {}) {
  const name = (id) => speakers[id]?.name || `Speaker ${id ?? '?'}`;
  const transcript = segments.map((s) => `[${fmt(s.start)}] ${name(s.speaker)}: ${s.text}`).join('\n');
  if (!transcript.trim()) throw Object.assign(new Error('There is no transcript to summarise yet.'), { status: 400 });
  const marks = bookmarks.length ? `\n\nBookmarks the user added while recording:\n${bookmarks.map((b) => `- [${fmt(b.t)}] ${b.label}`).join('\n')}` : '';
  const userNotes = rec.notes_md?.trim() ? `\n\nThe user's own notes:\n${rec.notes_md}` : '';

  const system = `You are a meticulous note-taker. You turn transcripts of sermons, lectures and meetings into accurate, well-organised notes in GitHub-flavoured Markdown.
Rules:
- Only use information present in the transcript; never invent names, numbers, dates or scripture references.
- Keep timestamps in [m:ss] or [h:mm:ss] form so the reader can jump to that moment.
- Refer to people by the speaker names given. The transcript may contain recognition errors; silently fix obvious ones, and mark genuinely unclear passages with "(unclear)".
- ${outputLanguage ? `Write the notes in ${outputLanguage}, translating from the transcript's language. Keep names and scripture references accurate, and quote short key phrases in the original language in brackets where nuance matters.` : 'Write in the same language as the transcript.'}
- Output only the Markdown notes, starting with a level-1 heading that is a good title.`;

  const stream = getClient().beta.messages.stream({
    model: config.claude.model,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system,
    messages: [{
      role: 'user',
      content: `${GUIDES[rec.kind] || GUIDES.other}\n\nTitle given by the user: ${rec.title}${marks}${userNotes}\n\n<transcript>\n${transcript}\n</transcript>`,
    }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to summarise this recording.'), { status: 422 });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Empty response from AI');
  return text;
}
