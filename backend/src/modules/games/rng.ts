import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Provably-fair RNG (commit–reveal).
 *
 * At round start the server publishes sha256(serverSeed). After settlement it reveals
 * serverSeed. Anyone can verify that sha256(serverSeed) matches the commitment and recompute
 * the outcome from HMAC-SHA256(serverSeed, "<game>:<roundNo>:<n>") — the server cannot change
 * the outcome after bets are placed.
 */
export function newServerSeed(): { seed: string; hash: string } {
  const seed = randomBytes(32).toString('hex');
  return { seed, hash: hashSeed(seed) };
}

export function hashSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** Deterministic stream of floats in [0, 1) derived from the seed and round. */
export function floats(seed: string, message: string, count: number): number[] {
  const out: number[] = [];
  for (let n = 0; out.length < count; n++) {
    const digest = createHmac('sha256', seed).update(`${message}:${n}`).digest();
    // 48 bits per float (6 bytes) → 5 floats per 32-byte digest.
    for (let i = 0; i + 6 <= digest.length && out.length < count; i += 6) {
      out.push(digest.readUIntBE(i, 6) / 2 ** 48);
    }
  }
  return out;
}

/** Pick a key from a weight table using a float in [0, 1). Weights need not sum to 1. */
export function weightedPick(weights: Record<string, number>, r: number): string {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (!entries.length) throw new Error('weight table is empty');
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let target = r * total;
  for (const [key, w] of entries) {
    if (target < w) return key;
    target -= w;
  }
  return entries[entries.length - 1]![0];
}

/** Fisher–Yates shuffle driven by the deterministic float stream. */
export function shuffle<T>(items: readonly T[], rs: number[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rs[a.length - 1 - i]! * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
