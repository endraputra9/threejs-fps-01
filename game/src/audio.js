// audio.js — every sound in RINGFALL is synthesised with WebAudio at play
// time: no audio files, no network. One master chain (gain → compressor →
// destination); each effect is a small recipe of oscillators and filtered
// noise. Distant shots are the same recipe quieter and darker, so a firefight
// across the ring sounds like one.

let ctx = null;
let master = null;
let noiseBuf = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(comp); comp.connect(ctx.destination);
  // Two seconds of white noise, reused by every noise-based recipe.
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function env(gain, t0, peak, decay) {
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
}

function noise({ dur = 0.2, type = 'lowpass', freq = 1200, q = 0.8, peak = 0.5, when = 0, sweepTo = null }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  src.playbackRate.value = 0.7 + Math.random() * 0.6;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const g = ctx.createGain(); env(g, t0, peak, dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function tone({ freq = 440, type = 'square', dur = 0.12, peak = 0.2, when = 0, slideTo = null }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  const g = ctx.createGain(); env(g, t0, peak, dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

// Weapon voices: a crack (bright noise) over a body thump (falling sine).
const VOICES = {
  wasp:    { crack: 2600, thump: 220, dur: 0.11, peak: 0.50 },
  ripper:  { crack: 2100, thump: 170, dur: 0.09, peak: 0.46 },
  mule:    { crack: 1300, thump: 110, dur: 0.30, peak: 0.85 },
  lance:   { crack: 1900, thump: 150, dur: 0.14, peak: 0.60 },
  osprey:  { crack: 1500, thump: 90,  dur: 0.45, peak: 0.95 },
  knife:   { crack: 3400, thump: 0,   dur: 0.05, peak: 0.18 },
};

export function shotSound(kind, distance = 0) {
  const v = VOICES[kind] || VOICES.lance;
  const att = 1 / (1 + distance * 0.055);            // distance falloff
  const dark = Math.max(500, v.crack - distance * 28); // and darkening
  noise({ dur: v.dur, freq: dark, peak: v.peak * att, sweepTo: dark * 0.4 });
  if (v.thump) tone({ freq: v.thump, type: 'sine', dur: v.dur * 1.4, peak: 0.35 * att, slideTo: v.thump * 0.5 });
}

export function dryFire() { tone({ freq: 1900, type: 'square', dur: 0.03, peak: 0.10 }); }
export function reloadSound(kind) {
  noise({ dur: 0.05, freq: 900, peak: 0.16 });
  noise({ dur: 0.05, freq: 1300, peak: 0.18, when: kind === 'mule' ? 0.3 : 0.22 });
  if (kind === 'mule') { noise({ dur: 0.05, freq: 1100, peak: 0.16, when: 0.6 }); noise({ dur: 0.06, freq: 800, peak: 0.2, when: 0.9 }); }
  // The fresh magazine seats with a click at the end of the reload.
  noise({ dur: 0.04, freq: 2400, peak: 0.14, when: kind === 'mule' ? 1.2 : 0.5 });
}
export function hitTick(kill = false) {
  tone({ freq: kill ? 1560 : 1180, type: 'triangle', dur: kill ? 0.16 : 0.06, peak: 0.22 });
  if (kill) tone({ freq: 780, type: 'triangle', dur: 0.2, peak: 0.18, when: 0.05 });
}
export function hurtSound() { noise({ dur: 0.14, freq: 500, peak: 0.3 }); tone({ freq: 130, type: 'sine', dur: 0.16, peak: 0.25, slideTo: 70 }); }
// Footsteps vary by surface of the deck: a soft boot on plate, a harder
// clack when sprinting — the bots hear the difference too.
export function stepSound(run) {
  const f = run ? 520 + Math.random() * 120 : 380 + Math.random() * 60;
  noise({ dur: 0.05, freq: f, peak: run ? 0.10 : 0.05 });
}
export function landSound(hard) {
  noise({ dur: hard ? 0.12 : 0.06, freq: hard ? 300 : 500, peak: hard ? 0.22 : 0.08 });
  if (hard) tone({ freq: 70, type: 'sine', dur: 0.1, peak: 0.2, slideTo: 40 });
}
export function scopeSound(on) {
  noise({ dur: 0.06, freq: on ? 1800 : 1200, peak: 0.08, sweepTo: on ? 2600 : 800 });
}
export function pinSound() { noise({ dur: 0.05, freq: 3000, peak: 0.12 }); tone({ freq: 2200, type: 'square', dur: 0.03, peak: 0.06 }); }
export function buySound(ok) { tone({ freq: ok ? 880 : 220, type: 'triangle', dur: 0.09, peak: 0.2 }); if (ok) tone({ freq: 1320, type: 'triangle', dur: 0.1, peak: 0.16, when: 0.06 }); }
export function throwSound() { noise({ dur: 0.12, freq: 700, peak: 0.10, sweepTo: 1600 }); }
export function explosionSound() {
  noise({ dur: 0.7, freq: 900, peak: 0.95, sweepTo: 90 });
  tone({ freq: 90, type: 'sine', dur: 0.65, peak: 0.7, slideTo: 34 });
}
export function smokeSound() { noise({ dur: 1.1, type: 'highpass', freq: 2400, peak: 0.10 }); }
export function dockBeep(step) { tone({ freq: 620 + step * 90, type: 'sine', dur: 0.09, peak: 0.22 }); }
export function dockedAlarm() {
  for (let i = 0; i < 3; i++) { tone({ freq: 980, type: 'square', dur: 0.11, peak: 0.14, when: i * 0.22 }); tone({ freq: 740, type: 'square', dur: 0.11, peak: 0.14, when: i * 0.22 + 0.11 }); }
}
export function drainTick() { tone({ freq: 1250, type: 'sine', dur: 0.05, peak: 0.10 }); }
export function purgeHum(t) { tone({ freq: 180 + t * 30, type: 'sawtooth', dur: 0.1, peak: 0.05 }); }
// The round-start horn: two low notes so the buy phase's end is heard,
// not just seen on the clock.
export function roundHorn() {
  tone({ freq: 196, type: 'sawtooth', dur: 0.28, peak: 0.12 });
  tone({ freq: 294, type: 'sawtooth', dur: 0.34, peak: 0.12, when: 0.18 });
}
export function roundStinger(won) {
  const base = won ? [523, 659, 784] : [392, 330, 262];
  base.forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.34, peak: 0.2, when: i * 0.13 }));
}
export function matchStinger(won) {
  const base = won ? [523, 659, 784, 1047] : [440, 392, 330, 262];
  base.forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.5, peak: 0.22, when: i * 0.16 }));
}
