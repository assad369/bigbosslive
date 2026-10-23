import { startGame, type OptionMeta, type Stage } from '../shared/shell';
import { easeOutCubic, GOLD, mountCanvas } from '../shared/canvas';

// Order matches the server's payout table; cabin i ↔ reveal.index i.
const OPTIONS: Record<string, OptionMeta> = {
  phoenix: { label: 'Phoenix', icon: '🦚', color: '#D9663B' },
  dragon: { label: 'Dragon', icon: '🐉', color: '#4E9A6B' },
  tiger: { label: 'Tiger', icon: '🐅', color: '#D08A1E' },
  koi: { label: 'Koi', icon: '🐟', color: '#D9734A' },
  lotus: { label: 'Lotus', icon: '🪷', color: '#D99AB8' },
  bamboo: { label: 'Bamboo', icon: '🎋', color: '#7BA05B' },
  lantern: { label: 'Lantern', icon: '🏮', color: '#C2504A' },
  fan: { label: 'Fan', icon: '🪭', color: '#8A6BB0' },
};
const KEYS = Object.keys(OPTIONS);

/**
 * A slowly turning ferris wheel. On reveal a spotlight races from cabin to cabin, slowing down
 * until it rests on the winning cabin.
 */
function ferrisStage(el: HTMLElement): Stage {
  let rotation = 0;
  let light: { from: number; to: number; start: number; duration: number } | null = null;
  let lit = -1;
  let settled = false;

  mountCanvas(el, (ctx, w, h, t) => {
    rotation += 0.0025;
    if (light) {
      const p = Math.min(1, (t - light.start) / light.duration);
      lit = Math.floor(light.from + (light.to - light.from) * easeOutCubic(p)) % KEYS.length;
      if (p >= 1) {
        light = null;
        settled = true;
      }
    }

    const cx = w / 2;
    const cy = h * 0.4;
    const r = Math.min(w, h) * 0.3;

    // Support legs
    ctx.strokeStyle = GOLD.bronze;
    ctx.lineWidth = Math.max(4, r * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - r * 0.75, cy + r * 1.35);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * 0.75, cy + r * 1.35);
    ctx.stroke();

    // Rim and spokes
    ctx.strokeStyle = GOLD.mid;
    ctx.lineWidth = Math.max(3, r * 0.035);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(233,207,122,0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    KEYS.forEach((_, i) => {
      const a = rotation + (i / KEYS.length) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    });

    // Cabins hang upright from the rim.
    KEYS.forEach((key, i) => {
      const a = rotation + (i / KEYS.length) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const size = r * 0.36;
      const isLit = i === lit;
      ctx.strokeStyle = GOLD.light;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + size * 0.25);
      ctx.stroke();
      ctx.save();
      if (isLit) {
        ctx.shadowColor = settled ? '#FFE9A8' : 'rgba(255,233,168,0.9)';
        ctx.shadowBlur = settled ? 30 + 10 * Math.sin(t / 120) : 22;
      }
      const g = ctx.createLinearGradient(x, y, x, y + size * 1.2);
      g.addColorStop(0, isLit ? '#FFF6D8' : '#F6EFE1');
      g.addColorStop(1, isLit ? GOLD.light : OPTIONS[key]!.color);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x - size / 2, y + size * 0.25, size, size, size * 0.28);
      ctx.fill();
      ctx.restore();
      ctx.font = `${Math.round(size * 0.55)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(OPTIONS[key]!.icon, x, y + size * 0.77);
    });

    // Hub
    const hub = ctx.createRadialGradient(cx, cy, 1, cx, cy, r * 0.14);
    hub.addColorStop(0, '#FFF6D8');
    hub.addColorStop(1, GOLD.deep);
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
  });

  return {
    idle() {
      lit = -1;
      settled = false;
      light = null;
    },
    reveal(outcome, reveal, durationMs) {
      const index = typeof reveal?.index === 'number' ? reveal.index : KEYS.indexOf(outcome);
      const from = Math.max(0, lit);
      // Several laps, ending exactly on the winning cabin.
      let to = from + KEYS.length * 4 + ((index - from + KEYS.length) % KEYS.length);
      if (to - from < KEYS.length * 3) to += KEYS.length;
      settled = false;
      light = {
        from,
        to: to + 0.999,
        start: performance.now(),
        duration: Math.min(durationMs, 6500),
      };
    },
  };
}

startGame({
  key: 'fortune_ferris',
  title: 'Fortune Ferris',
  columns: 4,
  options: OPTIONS,
  rules: [
    'Pick a chip and tap the cabins you believe the lucky light will stop on.',
    'When betting closes, the light races around the wheel and stops on one cabin.',
    'Winning bets pay the multiplier shown (stake included).',
    'Phoenix ×40, Dragon ×20, Tiger ×10, Koi ×8, the rest ×5.',
  ],
  mountStage: ferrisStage,
});
