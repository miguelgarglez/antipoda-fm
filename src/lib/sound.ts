// Tiny synthesized sound kit. Off by default — the header SND toggle arms it.
// Everything is generated: no audio assets.

let ctx: AudioContext | null = null;
let enabled = false;

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function soundOn(): boolean {
  return enabled;
}

export function toggleSound(): boolean {
  enabled = !enabled;
  if (ctx) {
    if (enabled) void ctx.resume();
    else void ctx.suspend(); // a dead toggle shouldn't hold a running context
  }
  return enabled;
}

/** Short burst of band-passed noise — radio static between signals. */
export function staticBurst(ms = 240, gain = 0.05) {
  const c = ac();
  if (!c) return;
  const dur = ms / 1000;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1600 + Math.random() * 800;
  bp.Q.value = 0.7;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  src.connect(bp).connect(g).connect(c.destination);
  src.start();
}

/** A 4ms detent click. */
export function detentClick() {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  o.type = "square";
  o.frequency.value = 2200;
  const g = c.createGain();
  g.gain.setValueAtTime(0.03, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.03);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.04);
}

/** Signal locked: a soft two-note blip. */
export function lockBlip() {
  const c = ac();
  if (!c) return;
  for (const [f, at] of [[620, 0], [930, 0.07]] as const) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime + at);
    g.gain.exponentialRampToValueAtTime(0.05, c.currentTime + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + 0.22);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + at);
    o.stop(c.currentTime + at + 0.25);
  }
}
