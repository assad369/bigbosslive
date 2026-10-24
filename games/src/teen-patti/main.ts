import { startGame, type OptionMeta, type Stage } from '../shared/shell';
import './teen-patti.css';

const OPTIONS: Record<string, OptionMeta> = {
  A: { label: 'Seat A', icon: 'A', color: '#C9A227' },
  B: { label: 'Seat B', icon: 'B', color: '#8C6239' },
  C: { label: 'Seat C', icon: 'C', color: '#B8860B' },
};

const SUIT: Record<string, { glyph: string; red: boolean }> = {
  s: { glyph: '♠', red: false },
  h: { glyph: '♥', red: true },
  d: { glyph: '♦', red: true },
  c: { glyph: '♣', red: false },
};
const RANK: Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

const HAND_LABEL: Record<string, string> = {
  trail: 'Trail',
  pure_sequence: 'Pure sequence',
  sequence: 'Sequence',
  color: 'Colour',
  pair: 'Pair',
  high_card: 'High card',
};

/** Three seats of three cards; on reveal the cards flip seat by seat and the winner glows. */
function teenPattiStage(el: HTMLElement): Stage {
  const table = document.createElement('div');
  table.className = 'tp-table';
  const seats = new Map<string, { root: HTMLElement; cards: HTMLElement[]; hand: HTMLElement }>();
  for (const seat of Object.keys(OPTIONS)) {
    const root = document.createElement('div');
    root.className = 'tp-seat';
    const name = document.createElement('div');
    name.className = 'tp-seat-name';
    name.textContent = OPTIONS[seat]!.label;
    const hand = document.createElement('div');
    hand.className = 'tp-hand';
    const row = document.createElement('div');
    row.className = 'tp-cards';
    const cards = [0, 1, 2].map(() => {
      const card = document.createElement('div');
      card.className = 'tp-card';
      card.innerHTML = '<div class="tp-face"></div><div class="tp-back"></div>';
      row.append(card);
      return card;
    });
    root.append(name, row, hand);
    table.append(root);
    seats.set(seat, { root, cards, hand });
  }
  el.prepend(table);
  const timers: number[] = [];

  const reset = () => {
    timers.splice(0).forEach(clearTimeout);
    for (const s of seats.values()) {
      s.root.classList.remove('winner', 'loser');
      s.hand.textContent = '';
      s.cards.forEach((c) => c.classList.remove('flipped'));
    }
  };

  return {
    idle: reset,
    reveal(outcome, reveal, durationMs) {
      reset();
      const data = (reveal ?? {}) as Record<string, { cards: string[]; hand: string }>;
      const step = Math.min(500, Math.max(200, (durationMs - 1500) / 9));
      let i = 0;
      for (const [seat, s] of seats) {
        const info = data[seat];
        s.cards.forEach((card, j) => {
          const code = info?.cards[j];
          if (code) {
            const suit = SUIT[code[1]!]!;
            const face = card.querySelector('.tp-face')!;
            face.innerHTML = `<span>${RANK[code[0]!] ?? code[0]}</span><span>${suit.glyph}</span>`;
            face.classList.toggle('red', suit.red);
          }
          timers.push(window.setTimeout(() => card.classList.add('flipped'), (i * 3 + j) * step));
        });
        timers.push(
          window.setTimeout(
            () => {
              s.hand.textContent = info ? (HAND_LABEL[info.hand] ?? info.hand) : '';
            },
            (i * 3 + 3) * step,
          ),
        );
        i++;
      }
      timers.push(
        window.setTimeout(
          () => {
            for (const [seat, s] of seats)
              s.root.classList.add(seat === outcome ? 'winner' : 'loser');
          },
          9 * step + 200,
        ),
      );
    },
  };
}

startGame({
  key: 'teen_patti',
  title: 'Teen Patti',
  columns: 3,
  options: OPTIONS,
  rules: [
    'Three seats are dealt three cards each from a freshly shuffled deck.',
    'Bet on the seat you think holds the best hand. Each seat pays ×2.9.',
    'Hands, best first: Trail › Pure sequence › Sequence › Colour › Pair › High card.',
    'A-K-Q is the top sequence, A-2-3 the second. Exact ties go to the highest suit (♠ ♥ ♦ ♣).',
  ],
  mountStage: teenPattiStage,
});
