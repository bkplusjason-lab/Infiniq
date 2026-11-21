// Pitch (fundamental frequency) estimation using the YIN algorithm.
// Used to estimate whether a voice is typically male or female.
export const PITCH_STEP = 0.1; // seconds between pitch samples
const TARGET_SR = 16000;
const MIN_F0 = 65, MAX_F0 = 450;

/** Downsamples a frame to ~16 kHz by block averaging. */
export function decimate(frame, sampleRate) {
  const f = Math.max(1, Math.round(sampleRate / TARGET_SR));
  if (f === 1) return { data: frame, sr: sampleRate };
  const out = new Float32Array(Math.floor(frame.length / f));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < f; j++) s += frame[i * f + j]; out[i] = s / f; }
  return { data: out, sr: sampleRate / f };
}

/** Returns the F0 in Hz of a short frame, or 0 if it is silent/unvoiced. */
export function estimateF0(frame, sr, rmsGate = 0.008) {
  let rms = 0;
  for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / frame.length);
  if (rms < rmsGate) return 0;
  const tauMin = Math.floor(sr / MAX_F0), tauMax = Math.min(Math.floor(sr / MIN_F0), Math.floor(frame.length / 2));
  const W = frame.length - tauMax;
  if (W < 64) return 0;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = frame[i] - frame[i + tau]; s += x * x; }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  let running = 0; const cmnd = new Float32Array(tauMax + 1); cmnd[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; cmnd[tau] = running ? (d[tau] * tau) / running : 1; }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < 0.15) { while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
  }
  if (tau < 0) return 0;
  // parabolic interpolation
  const a = cmnd[tau - 1] ?? cmnd[tau], b = cmnd[tau], c = cmnd[tau + 1] ?? cmnd[tau];
  const denom = a + c - 2 * b;
  const better = denom ? tau + (a - c) / (2 * denom) : tau;
  const f0 = sr / better;
  return f0 >= MIN_F0 && f0 <= MAX_F0 ? f0 : 0;
}

/** Computes a pitch track for a whole decoded recording (mono samples). */
export async function pitchTrackFromSamples(samples, sampleRate, onProgress) {
  const { data, sr } = sampleRate > TARGET_SR * 1.5 ? decimate(samples, sampleRate) : { data: samples, sr: sampleRate };
  const hop = Math.round(sr * PITCH_STEP), win = Math.round(sr * 0.045);
  const f0 = [];
  for (let i = 0, k = 0; i + win < data.length; i += hop, k++) {
    f0.push(Math.round(estimateF0(data.subarray(i, i + win), sr)));
    if (k % 500 === 0) { onProgress?.(i / data.length); await new Promise((r) => setTimeout(r)); }
  }
  return { step: PITCH_STEP, f0 };
}

/** Decodes an audio/video file at 16 kHz and returns { duration, pitch }. */
export async function analyseFile(file, onProgress) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, TARGET_SR);
  const audio = await ctx.decodeAudioData(buf);
  const pitch = await pitchTrackFromSamples(audio.getChannelData(0), audio.sampleRate, onProgress);
  return { duration: audio.duration, pitch };
}
