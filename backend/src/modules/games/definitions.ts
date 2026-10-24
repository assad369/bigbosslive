import type { GameKey } from '@bigboss/shared';
import type { GameConfig } from '../../db/schema.js';
import { floats, shuffle, weightedPick } from './rng.js';
import { compare, DECK, evaluate, SUITS, type Card } from './teenPatti.js';

export interface Resolution {
  outcome: string;
  reveal: Record<string, unknown>;
}

export interface GameDefinition {
  key: GameKey;
  name: string;
  defaultConfig: GameConfig;
  resolve(serverSeed: string, roundNo: number, config: GameConfig): Resolution;
}

/** Weights ∝ 1/multiplier give every option the same RTP = 1 / Σ(1/m). */
function inverseWeights(payouts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(payouts).map(([k, m]) => [k, Math.round(1000 / m)]));
}

const WHEEL_PAYOUTS = {
  crown: 45,
  diamond: 25,
  ring: 15,
  coin: 10,
  cherry: 5,
  lemon: 5,
  grape: 5,
  melon: 5,
};
const FERRIS_PAYOUTS = {
  phoenix: 40,
  dragon: 20,
  tiger: 10,
  koi: 8,
  lotus: 5,
  bamboo: 5,
  lantern: 5,
  fan: 5,
};

const CHIPS = [100, 1_000, 10_000, 100_000];

function weightedGame(key: GameKey, name: string, payouts: Record<string, number>): GameDefinition {
  return {
    key,
    name,
    defaultConfig: {
      bettingSeconds: 25,
      revealSeconds: 8,
      minBet: 100,
      maxBet: 1_000_000,
      maxRoundStake: 5_000_000,
      chips: CHIPS,
      payouts,
      weights: inverseWeights(payouts),
    },
    resolve(seed, roundNo, config) {
      const [r] = floats(seed, `${key}:${roundNo}`, 1);
      const outcome = weightedPick(config.weights, r!);
      return { outcome, reveal: { index: Object.keys(config.payouts).indexOf(outcome) } };
    },
  };
}

const SUIT_ORDER = (c: Card) => SUITS.length - SUITS.indexOf(c[1] as (typeof SUITS)[number]);

const teenPatti: GameDefinition = {
  key: 'teen_patti',
  name: 'Teen Patti',
  defaultConfig: {
    bettingSeconds: 20,
    revealSeconds: 10,
    minBet: 100,
    maxBet: 1_000_000,
    maxRoundStake: 5_000_000,
    chips: CHIPS,
    // Three seats, each wins 1/3 of the time → RTP 2.9 / 3 ≈ 96.7%.
    payouts: { A: 2.9, B: 2.9, C: 2.9 },
    weights: { A: 1, B: 1, C: 1 },
  },
  resolve(seed, roundNo) {
    const deck = shuffle(DECK, floats(seed, `teen_patti:${roundNo}`, DECK.length));
    const seats = ['A', 'B', 'C'] as const;
    const hands = seats.map((seat, i) => {
      const cards = [deck[i * 3]!, deck[i * 3 + 1]!, deck[i * 3 + 2]!] as [Card, Card, Card];
      return { seat, cards, hand: evaluate(cards) };
    });
    hands.sort((a, b) => {
      const d = compare(b.hand, a.hand);
      if (d !== 0) return d;
      // Identical ranks: the higher suit of the highest card wins (spades > hearts > diamonds > clubs).
      const topSuit = (cards: Card[]) => Math.max(...cards.map(SUIT_ORDER));
      return topSuit(b.cards) - topSuit(a.cards);
    });
    const winner = hands[0]!;
    return {
      outcome: winner.seat,
      reveal: Object.fromEntries(hands.map((h) => [h.seat, { cards: h.cards, hand: h.hand.name }])),
    };
  },
};

export const GAME_DEFINITIONS: Record<GameKey, GameDefinition> = {
  golden_wheel: weightedGame('golden_wheel', 'Golden Wheel', WHEEL_PAYOUTS),
  fortune_ferris: weightedGame('fortune_ferris', 'Fortune Ferris', FERRIS_PAYOUTS),
  teen_patti: teenPatti,
};

/** Theoretical return-to-player for a weighted game config (same for every option when weights ∝ 1/m). */
export function theoreticalRtp(config: GameConfig): Record<string, number> {
  const total = Object.values(config.weights).reduce((s, w) => s + w, 0);
  return Object.fromEntries(
    Object.entries(config.payouts).map(([k, m]) => [
      k,
      total ? ((config.weights[k] ?? 0) / total) * m : 0,
    ]),
  );
}
