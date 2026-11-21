import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoice, clusterSpeakersByPitch, buildSpeakers } from '../src/services/voices.js';

test('classifies typical male and female pitch', () => {
  assert.equal(classifyVoice(Array(30).fill(110)).voice, 'male');
  assert.equal(classifyVoice(Array(30).fill(220)).voice, 'female');
  assert.equal(classifyVoice([120, 130]).voice, 'unknown');
});

test('keeps diarized speakers and estimates each voice', () => {
  const pitch = { step: 0.1, f0: [...Array(50).fill(100), ...Array(50).fill(230)] };
  const segs = [{ start: 0, end: 5, text: 'a', speaker: 'A' }, { start: 5, end: 10, text: 'b', speaker: 'B' }];
  const s = buildSpeakers(segs, pitch, { A: { name: 'Bob' } });
  assert.equal(s.A.name, 'Bob');
  assert.equal(s.A.voice, 'male');
  assert.equal(s.B.voice, 'female');
});

test('clusters undiarized segments by pitch', () => {
  const pitch = { step: 0.1, f0: [...Array(30).fill(105), ...Array(30).fill(225), ...Array(30).fill(108)] };
  const segs = [{ start: 0, end: 3, text: 'a' }, { start: 3, end: 6, text: 'b' }, { start: 6, end: 9, text: 'c' }];
  const out = clusterSpeakersByPitch(segs, pitch);
  assert.equal(out[0].speaker, out[2].speaker);
  assert.notEqual(out[0].speaker, out[1].speaker);
});
