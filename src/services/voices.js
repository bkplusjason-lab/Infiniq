// Voice analysis: estimates whether each speaker has a typically male or female
// voice from the fundamental frequency (pitch) track recorded in the browser.
// Adult male speech usually sits around 85-155 Hz, adult female around 165-255 Hz.
// This is a statistical estimate, not identity recognition; users can correct it.

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function voicedPitchIn(pitch, start, end) {
  if (!pitch?.f0?.length || !pitch.step) return [];
  const i0 = Math.max(0, Math.floor(start / pitch.step));
  const i1 = Math.min(pitch.f0.length, Math.ceil(end / pitch.step));
  const out = [];
  for (let i = i0; i < i1; i++) { const v = pitch.f0[i]; if (v >= 60 && v <= 450) out.push(v); }
  return out;
}

export function classifyVoice(values) {
  if (values.length < 15) return { voice: 'unknown', f0: values.length ? Math.round(median(values)) : null, confidence: 0 };
  const f0 = median(values);
  let voice, confidence;
  if (f0 < 150) { voice = 'male'; confidence = Math.min(0.95, 0.7 + (150 - f0) / 150); }
  else if (f0 > 185) { voice = 'female'; confidence = Math.min(0.95, 0.7 + (f0 - 185) / 150); }
  else { voice = f0 < 167 ? 'male' : 'female'; confidence = 0.5 + Math.abs(f0 - 167) / 60; }
  return { voice, f0: Math.round(f0), confidence: Math.round(confidence * 100) / 100 };
}

/** When the transcript has no diarization, group segments into speakers by pitch. */
export function clusterSpeakersByPitch(segments, pitch) {
  const meds = segments.map((s) => { const v = voicedPitchIn(pitch, s.start, s.end); return v.length >= 8 ? median(v) : null; });
  const known = meds.map((m, i) => ({ m, i })).filter((x) => x.m != null).sort((a, b) => a.m - b.m);
  const clusters = [];
  for (const x of known) {
    const c = clusters[clusters.length - 1];
    if (c && x.m - c.last < 28 && x.m - c.first < 60) { c.items.push(x.i); c.last = x.m; }
    else if (clusters.length < 6) clusters.push({ items: [x.i], first: x.m, last: x.m });
    else { clusters[clusters.length - 1].items.push(x.i); clusters[clusters.length - 1].last = x.m; }
  }
  const labelOf = new Map();
  clusters.forEach((c, ci) => c.items.forEach((i) => labelOf.set(i, String(ci + 1))));
  // segments with too little voiced audio inherit the previous speaker
  let prev = clusters.length ? '1' : 'U';
  return segments.map((s, i) => { const sp = labelOf.get(i) || prev; prev = sp; return { ...s, speaker: sp }; });
}

/** Builds/refreshes the speaker table, keeping any names/voices the user edited. */
export function buildSpeakers(segments, pitch, existing = {}) {
  const ids = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  const out = {};
  ids.forEach((id, idx) => {
    const values = segments.filter((s) => s.speaker === id).flatMap((s) => voicedPitchIn(pitch, s.start, s.end));
    const est = classifyVoice(values);
    const prev = existing[id] || {};
    const label = /^\d+$/.test(id) ? id : id === 'U' ? '1' : String(idx + 1);
    out[id] = {
      name: prev.name || `Speaker ${label}`,
      voice: prev.manualVoice ? prev.voice : est.voice,
      manualVoice: !!prev.manualVoice,
      f0: est.f0,
      confidence: est.confidence,
    };
  });
  return out;
}
