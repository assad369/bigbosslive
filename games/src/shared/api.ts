import type { ApiErrorBody, GameKey, GameRound } from '@bigboss/shared';
import { apiOrigin, currentToken, refreshToken } from './bridge';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`${apiOrigin}/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${currentToken()}`,
      ...(init.headers ?? {}),
    },
  }).catch(() => {
    throw new ApiError(0, 'network', 'Connection lost — retrying…');
  });
  if (res.status === 401 && !retried) {
    await refreshToken();
    return request<T>(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error.code ?? 'error',
      body?.error.message ?? `Request failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

export interface GameState {
  game: {
    key: GameKey;
    name: string;
    enabled: boolean;
    chips: number[];
    payouts: Record<string, number>;
    minBet: number;
    maxBet: number;
  };
  round: GameRound | null;
  myBets: Record<string, number>;
  diamonds: number;
  history: { roundNo: number; outcome: string }[];
  serverTime: string;
}

export const getState = (game: GameKey) => request<GameState>(`/games/${game}/state`);

export const placeBet = (game: GameKey, roundId: string, option: string, amount: number) =>
  request<{ betId: string; diamonds: number; replayed: boolean }>(`/games/${game}/bets`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `bet-${crypto.randomUUID()}` },
    body: JSON.stringify({ roundId, option, amount }),
  });
