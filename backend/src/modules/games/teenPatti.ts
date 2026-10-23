/**
 * Teen Patti hand evaluation. Ranks, high to low:
 * trail (three of a kind) > pure sequence > sequence > color (flush) > pair > high card.
 * A-2-3 is the second-highest sequence after A-K-Q, matching common Teen Patti rules.
 */
export const SUITS = ['s', 'h', 'd', 'c'] as const;
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type Card = `${(typeof RANKS)[number]}${(typeof SUITS)[number]}`;

export const DECK: Card[] = RANKS.flatMap((r) => SUITS.map((s) => `${r}${s}` as Card));

const rankValue = (c: Card) => RANKS.indexOf(c[0] as (typeof RANKS)[number]) + 2;

export const HAND_NAMES = [
  'high_card',
  'pair',
  'color',
  'sequence',
  'pure_sequence',
  'trail',
] as const;
export type HandName = (typeof HAND_NAMES)[number];

export interface HandScore {
  name: HandName;
  /** Comparable tuple: [category, ...tiebreakers]. */
  score: number[];
}

export function evaluate(hand: readonly [Card, Card, Card]): HandScore {
  const values = hand.map(rankValue).sort((a, b) => b - a) as [number, number, number];
  const suits = new Set(hand.map((c) => c[1]));
  const flush = suits.size === 1;

  const isAce23 = values[0] === 14 && values[1] === 3 && values[2] === 2;
  const consecutive = values[0] - values[1] === 1 && values[1] - values[2] === 1;
  const straight = consecutive || isAce23;
  // Sequence strength: A-K-Q = 15, A-2-3 = 14.5, then by top card (K-Q-J = 13 …).
  const straightHigh = isAce23 ? 14.5 : values[0] === 14 && values[1] === 13 ? 15 : values[0];

  if (values[0] === values[2]) return { name: 'trail', score: [5, values[0]] };
  if (straight && flush) return { name: 'pure_sequence', score: [4, straightHigh] };
  if (straight) return { name: 'sequence', score: [3, straightHigh] };
  if (flush) return { name: 'color', score: [2, ...values] };
  if (values[0] === values[1] || values[1] === values[2]) {
    const pair = values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    return { name: 'pair', score: [1, pair, kicker] };
  }
  return { name: 'high_card', score: [0, ...values] };
}

export function compare(a: HandScore, b: HandScore): number {
  for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
    const d = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
