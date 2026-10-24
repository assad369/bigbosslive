import { startGame, type OptionMeta, type Stage } from '../shared/shell';
import { easeOutQuint, GOLD, mountCanvas } from '../shared/canvas';

// Order matches the server's payout table (crown … melon); segment i ↔ reveal.index i.
const OPTIONS: Record<string, OptionMeta> = {
  crown: { label: 'Crown', icon: '👑', color: '#E9CF7A' },
  diamond: { label: 'Diamond', icon: '💎', color: '#7FB7D9' },
  ring: { label: 'Ring', icon: '💍', color: '#D9A6C4' },
  coin: { label: 'Coin', icon: '🪙', color: '#C9A227' },
  cherry: { label: 'Cherry', icon: '🍒', color: '#C2504A' },
  lemon: { label: 'Lemon', icon: '🍋', color: '#D9C24A' },
  grape: { label: 'Grape', icon: '🍇', color: '#8A5BA8' },
  melon: { label: 'Melon', icon: '🍉', color: '#5E9E5A' },
};
const KEYS = Object.keys(OPTIONS);
const SEG = (Math.PI * 2) / KEYS.length;

function wheelStage(el: HTMLElement): Stage {
  let angle = 0;
  let spin: { from: number; to: number; start: number; duration: number } | null = null;
  let idleSpeed = 0.0006;
  let winner: number | null = null;

  mountCanvas(el, (ctx, w, h, t) => {
    if (spin) {
      const p = Math.min(1, (t - spin.start) / spin.duration);
      angle = spin.from + (spin.to - spin.from) * easeOutQuint(p);
      if (p >= 1) spin = null;
    } else if (winner === null) {
      angle += idleSpeed * 16;
    }

    const cx = w / 2;
    const cy = h * 0.48;
    const r = Math.min(w, h) * 0.4;

    // Outer glow + rim with bulbs
    const glow = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.25);
    glow.addColorStop(0, 'rgba(233,207,122,0.35)');
    glow.addColorStop(1, 'rgba(233,207,122,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
    ctx.fill();

    const rim = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    rim.addColorStop(0, GOLD.light);
    rim.addColorStop(0.5, GOLD.mid);
    rim.addColorStop(1, GOLD.deep);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.08, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const on = Math.floor(t / 180 + i) % 2 === 0;
      ctx.fillStyle = on ? '#FFF6D8' : 'rgba(255,246,216,0.35)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r * 1.04, cy + Math.sin(a) * r * 1.04, r * 0.022, 0, Math.PI * 2);
      ctx.fill();
    }

    // Segments
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    KEYS.forEach((key, i) => {
      const a0 = i * SEG - Math.PI / 2 - SEG / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a0, a0 + SEG);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? '#3A2B1B' : '#F6EFE1';
      ctx.fill();
      if (winner === i && !spin) {
        ctx.fillStyle = `rgba(233,207,122,${0.45 + 0.35 * Math.sin(t / 120)})`;
        ctx.fill();
      }
      ctx.strokeStyle = GOLD.mid;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.rotate(a0 + SEG / 2);
      ctx.translate(r * 0.68, 0);
      ctx.rotate(Math.PI / 2);
      ctx.font = `${Math.round(r * 0.2)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(OPTIONS[key]!.icon, 0, 0);
      ctx.restore();
    });
    ctx.restore();

    // Hub
    const hub = ctx.createRadialGradient(cx - r * 0.05, cy - r * 0.05, 2, cx, cy, r * 0.2);
    hub.addColorStop(0, '#FFF6D8');
    hub.addColorStop(1, GOLD.deep);
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${Math.round(r * 0.16)}px system-ui, "Apple Color Emoji"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👑', cx, cy + 1);

    // Pointer at the top
    ctx.fillStyle = GOLD.ivory;
    ctx.strokeStyle = GOLD.deep;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.86);
    ctx.lineTo(cx - r * 0.09, cy - r * 1.16);
    ctx.lineTo(cx + r * 0.09, cy - r * 1.16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });

  return {
    idle() {
      winner = null;
      idleSpeed = 0.0006;
    },
    reveal(outcome, reveal, durationMs) {
      const index = typeof reveal?.index === 'number' ? reveal.index : KEYS.indexOf(outcome);
      // Segment i is centred at angle i·SEG when rotation is 0; to bring it under the top
      // pointer the wheel must rotate to −i·SEG (mod 2π), plus several full turns.
      const target = -index * SEG;
      const base = angle - (angle % (Math.PI * 2));
      let to = base + target + Math.PI * 2 * 6;
      while (to < angle + Math.PI * 8) to += Math.PI * 2;
      spin = { from: angle, to, start: performance.now(), duration: Math.min(durationMs, 7000) };
      winner = index;
    },
  };
}

startGame({
  key: 'golden_wheel',
  title: 'Golden Wheel',
  columns: 4,
  options: OPTIONS,
  rules: [
    'Pick a chip, then tap any symbols to place bets while the timer runs.',
    'When betting closes the wheel spins and stops on one symbol.',
    'Bets on the winning symbol pay the multiplier shown (stake included).',
    'Rarer symbols pay more: 👑 ×45, 💎 ×25, 💍 ×15, 🪙 ×10, fruits ×5.',
  ],
  mountStage: wheelStage,
});
