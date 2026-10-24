/** Tiny synthesized sound effects (no audio assets to download). Muted until first tap. */
let ctx: AudioContext | null = null;
let enabled = true;

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    enabled = false;
    return null;
  }
}

function tone(freq: number, ms: number, type: OscillatorType = 'sine', gain = 0.06, delay = 0) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = a.currentTime + delay / 1000;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + ms / 1000);
}

export const sfx = {
  tick: () => tone(1200, 40, 'square', 0.02),
  chip: () => tone(880, 70, 'triangle', 0.05),
  spin: () => [0, 120, 240].forEach((d, i) => tone(400 + i * 120, 90, 'sine', 0.04, d)),
  win: () => [0, 110, 220, 330].forEach((d, i) => tone(660 + i * 165, 160, 'triangle', 0.06, d)),
  setEnabled: (on: boolean) => (enabled = on),
};
