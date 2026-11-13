import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

/**
 * AsadSoft, the HTML5 games provider. We are one of its operators: our backend launches
 * sessions with the operator API key, and AsadSoft moves money by calling our wallet
 * callbacks (`routes/asadsoft-wallet.ts`). See docs/GAMES.md for the contract.
 */

/** One row of the operator's catalogue (`GET /games`). */
export interface AsadSoftGame {
  gameId: string;
  name: string;
  category: string;
  thumbnailUrl: string | null;
  sortOrder: number;
}

export interface AsadSoftLaunchInput {
  gameId: string;
  /** Our uid. AsadSoft puts it inside `:`-separated txIds, so no `:` in it. */
  playerId: string;
  playerUsername: string;
  playerAvatar: string | null;
  language: string;
}

export interface AsadSoftLaunch {
  sessionId: string;
  /** `https://<games host>/<gameId>/?token=<session JWT>&lang=..` */
  gameUrl: string;
  expiresAt: Date;
}

export interface AsadSoftPurchase {
  purchaseId: string;
  playerId: string;
  diamonds: number;
  purchasedAt: Date;
  source: string;
}

export interface AsadSoftGateway {
  readonly configured: boolean;
  /** Every game the operator is allowed, across all pages. */
  listGames(): Promise<AsadSoftGame[]>;
  launch(input: AsadSoftLaunchInput): Promise<AsadSoftLaunch>;
  /** End one session with its own token (AsadSoft has no API-key route for this). */
  endSession(sessionId: string, token: string): Promise<void>;
  /** Report recharges (reporting only; idempotent on purchaseId on their side). */
  reportPurchases(rows: AsadSoftPurchase[]): Promise<{ recorded: number; duplicates: number }>;
}

export const gamesUnavailable = (message = 'Games are not available right now') =>
  new AppError(503, 'games_unavailable', message);
export const gameUnavailable = (message = 'This game is not available right now') =>
  new AppError(403, 'game_unavailable', message);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One `GET /games` item as an [AsadSoftGame]. Pure. */
export function gameFromApi(item: unknown): AsadSoftGame | null {
  const g = obj(item);
  const gameId = str(g.gameId);
  if (!/^[a-z0-9-]{1,64}$/.test(gameId)) return null;
  return {
    gameId,
    name: str(g.name).slice(0, 80) || gameId,
    category: str(g.category) || 'casual',
    thumbnailUrl: str(g.thumbnailUrl) || null,
    sortOrder: typeof g.sortOrder === 'number' && Number.isFinite(g.sortOrder) ? g.sortOrder : 0,
  };
}

/** The `?token=` of a launch URL: the session JWT. Pure. */
export function sessionTokenOf(gameUrl: string): string | null {
  try {
    return new URL(gameUrl).searchParams.get('token');
  } catch {
    return null;
  }
}

const TIMEOUT_MS = 10_000;

export class HttpAsadSoft implements AsadSoftGateway {
  private readonly base: string | null;

  constructor(
    apiUrl: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = apiUrl ? apiUrl.replace(/\/+$/, '') : null;
  }

  get configured() {
    return Boolean(this.base && this.apiKey);
  }

  async listGames(): Promise<AsadSoftGame[]> {
    const games: AsadSoftGame[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.call('GET', `/games?page=${page}&limit=100`);
      const data = obj(body.data);
      const items = Array.isArray(data.games) ? data.games : [];
      for (const it of items) {
        const g = gameFromApi(it);
        if (g) games.push(g);
      }
      const pages = Number(obj(data.pagination).pages ?? 1);
      if (items.length === 0 || page >= pages) break;
    }
    return games;
  }

  async launch(input: AsadSoftLaunchInput): Promise<AsadSoftLaunch> {
    const body = await this.call('POST', '/sessions/launch', {
      gameId: input.gameId,
      playerId: input.playerId,
      playerUsername: input.playerUsername,
      ...(input.playerAvatar ? { playerAvatar: input.playerAvatar } : {}),
      language: input.language,
      deviceType: 'mobile',
      platform: 'bigbosslive',
    });
    const data = obj(body.data);
    const gameUrl = str(data.gameUrl);
    const sessionId = str(data.sessionId);
    const expiresAt = new Date(str(data.expiresAt));
    if (!gameUrl || !sessionId) throw gamesUnavailable('The game server sent an invalid reply');
    return {
      gameUrl,
      sessionId,
      expiresAt: Number.isNaN(expiresAt.getTime())
        ? new Date(Date.now() + 4 * 3600_000)
        : expiresAt,
    };
  }

  async endSession(sessionId: string, token: string): Promise<void> {
    await this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/end`, {}, token);
  }

  async reportPurchases(rows: AsadSoftPurchase[]) {
    if (rows.length === 0) return { recorded: 0, duplicates: 0 };
    const body = await this.call('POST', '/purchases', {
      purchases: rows.map((r) => ({
        purchaseId: r.purchaseId,
        playerId: r.playerId,
        diamonds: r.diamonds,
        purchasedAt: r.purchasedAt.toISOString(),
        source: r.source,
        currency: 'DIAMOND',
      })),
    });
    const data = obj(body.data ?? body);
    return { recorded: Number(data.recorded ?? 0), duplicates: Number(data.duplicates ?? 0) };
  }

  /**
   * One JSON call. With `bearer`, the session JWT authenticates instead of the API key.
   * Provider refusals become AppErrors the app can show; outages are 503 `games_unavailable`.
   */
  private async call(method: string, path: string, payload?: Json, bearer?: string): Promise<Json> {
    if (!this.base || !this.apiKey) throw gamesUnavailable('Games are not configured');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : { 'x-api-key': this.apiKey }),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw gamesUnavailable('The game server is not responding, try again');
    }
    const body = obj(await res.json().catch(() => null));
    if (res.ok && body.success !== false) return body;
    const why = (str(body.error) || str(body.message)).slice(0, 200);
    if (res.status === 403) throw gameUnavailable(why || undefined);
    if (res.status === 404) throw new AppError(404, 'game_not_found', why || 'Game not found');
    if (res.status === 400) throw new AppError(502, 'games_bad_request', why || 'Bad request');
    throw gamesUnavailable(why ? `Games are not available right now (${why})` : undefined);
  }
}

export function createAsadSoftGateway(env: Env): AsadSoftGateway {
  return new HttpAsadSoft(env.ASADSOFT_API_URL, env.ASADSOFT_API_KEY);
}
