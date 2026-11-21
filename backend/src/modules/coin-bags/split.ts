import { randomInt } from 'node:crypto';

/** A uniform integer in [0, n). */
export type RandomInt = (n: number) => number;

const cryptoRandom: RandomInt = (n) => (n <= 1 ? 0 : randomInt(n));

/** The platform fee (floored) and what is left for the shares. */
export function feeSplit(amount: number, feeRate: number): { fee: number; pool: number } {
  const fee = Math.floor(amount * feeRate);
  return { fee, pool: amount - fee };
}

/**
 * Splits `pool` into `count` random integer shares, each at least `minShare`, summing to
 * exactly `pool` ("double average": each share is drawn up to twice the average of what is
 * left, so nobody can take nearly everything), then shuffled so the order says nothing.
 */
export function splitShares(
  pool: number,
  count: number,
  minShare: number,
  random: RandomInt = cryptoRandom,
): number[] {
  if (!Number.isSafeInteger(pool) || !Number.isSafeInteger(count) || count < 1)
    throw new Error('Invalid split');
  if (pool < count * minShare) throw new Error('Pool too small for the shares');
  const shares: number[] = [];
  let remaining = pool;
  for (let i = 0; i < count - 1; i++) {
    const left = count - i;
    // Leave every later share its minimum.
    const ceiling = remaining - (left - 1) * minShare;
    const doubleAvg = Math.floor((2 * remaining) / left);
    const hi = Math.max(minShare, Math.min(ceiling, doubleAvg));
    const v = hi > minShare ? minShare + random(hi - minShare + 1) : minShare;
    shares.push(v);
    remaining -= v;
  }
  shares.push(remaining);
  for (let i = shares.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [shares[i], shares[j]] = [shares[j]!, shares[i]!];
  }
  return shares;
}
