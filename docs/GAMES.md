# Games (AsadSoft)

BigBoss Live's games are provided by **AsadSoft**, an HTML5 game provider. We are one of its
*operators*:

```
 App ── POST /v1/games/:id/launch ──▶ backend ── POST /sessions/launch (X-API-Key) ──▶ AsadSoft
  │                                      ▲                                             │
  │ WebView loads gameUrl (?token=JWT)   │ GET /balance, POST /debit, POST /credit     │
  └──────────────────────────────────────┼─── (Bearer token + HMAC X-Signature) ◀──────┘
                                         │
                       /v1/webhooks/asadsoft/*  → WalletService (diamonds + ledger)
```

- The backend opens a session with the operator API key and gets a `gameUrl` carrying a
  4-hour session token. The API key never reaches the app.
- The app opens that URL in a bottom sheet at 75% height, from the Games screen and in live rooms.
- Every stake, win, refund and cashback is a call from AsadSoft to **our wallet callbacks**.
  Players stake diamonds straight from their wallet.

## Setup

### 1. Backend env

| Variable | What |
|---|---|
| `ASADSOFT_API_URL` | `https://api.asadsoft.cloud/api/v1` |
| `ASADSOFT_API_KEY` | The operator API key (`ask_live_…`) |
| `ASADSOFT_API_SECRET` | The operator `apiSecret` (Operators → rotate secret; shown once). Verifies `X-Signature` |
| `ASADSOFT_WALLET_TOKEN` | A long random string (`openssl rand -hex 32`), also entered in AsadSoft as the wallet token |
| `ASADSOFT_CALLBACK_IPS` | Optional: AsadSoft server IPs allowed to call the wallet |
| `GAMES_REPORT_TIMEZONE` | Day boundaries of the reports (default `Asia/Dhaka`) |

Set all four `ASADSOFT_*` keys or none; a partial set fails at boot. With none set, games
are off: launch answers 503 and the wallet callbacks refuse (503).

### 2. The operator in AsadSoft's dashboard (Operators → ours)

- **Wallet callback URL:** `<PUBLIC_BASE_URL>/v1/webhooks/asadsoft`. Admin → Games → Settings
  shows it with a copy button.
- **Wallet auth type:** `bearer`, token = `ASADSOFT_WALLET_TOKEN`.
- **Currency:** `DIAMOND`. It is a whole-unit currency, so AsadSoft only offers chips that pay
  whole diamonds.
- **Allowed games:** the playable ones. With "allow all games", the catalogue also lists
  rows that have no browser build (`slots777`, `lucky-wheel`, `teenpatti`, `dragon-tiger`).
  They sync in disabled, but there is no reason to list them. The playable games are:
  - `greedy-star2`, `elephant-pro`, `lion3-pro`, `lucky-77-pro`
  - `greedy-monkey`, `greedy-lion`, `fruit-machine`, `roulette`
  - `beach-party-pro`, `royal-teen-patti`, `crazy-teen-patti`, `jackpot`
- **RTP profile, loss cashback, transfer wallet:** AsadSoft's settings. Our wallet handles all
  of them.

### 3. Prove the wallet against AsadSoft's conformance check (staging)

From the AsadSoft repo, with a staging player holding at least 1000 diamonds:

```bash
cd packages/game-server
WALLET_URL=https://<staging-api>/v1/webhooks/asadsoft WALLET_TOKEN=<ASADSOFT_WALLET_TOKEN> \
  WALLET_AUTH_TYPE=bearer API_SECRET=<ASADSOFT_API_SECRET> WALLET_CURRENCY=DIAMOND \
  npm run wallet:conformance -- --player <uid>
```

It must exit 0. `backend/test/games-wallet.test.ts` runs the same cases in CI.

### 4. Turn games on

1. Admin → Games → Catalogue → **Sync from AsadSoft**. New games arrive **off**.
2. Upload an icon for each game. AsadSoft sends no artwork; without an icon the app shows a
   plain tile.
3. Switch the games on.
4. Optional: report past recharges to AsadSoft with `npm run games:backfill-purchases -w backend`.

The catalogue also re-syncs every hour (`games.sync`).

## Admin controls (Admin → Games)

| Control | Where | Effect |
|---|---|---|
| Games on/off | Settings (`features.gamesEnabled`) | Off: no list or launch, open sessions ended, new stakes refused |
| Global minimum level | Settings (`games.minLevel`) | Lower-level players see a lock and can't stake |
| Games in live rooms | Settings (`games.liveRoomEnabled`) | Hides the live room's Games button (`gamesInLive` in `/config/app`) |
| Show locked games | Settings (`games.showLocked`) | Off: games a player's level doesn't reach are hidden |
| Per game: on/off, live rooms, min level, order, name, icon | Catalogue | A game's min level overrides the global one |
| Block a player | Players, or the user page (`games.block`: moderators and admins) | Launch refused, open sessions ended, new stakes refused |

**How fast changes apply:**
- Global settings: within 30 seconds on every server (config cache). Per-game controls and
  blocks: at once.
- A change also applies to sessions that are already open. The **stake gate** in the wallet
  refuses a new stake (403) from a player who may no longer play. Wins, refunds, cashback and
  claw-backs are never refused, so nobody loses money already owed to them.
- Ending open sessions is best-effort (`games.end_sessions`). AsadSoft has no API-key route
  for it, so we end each session with its own token, kept in `game_sessions`.

Every admin change is audited: `game.update`, `game.settings`, `game.sync`,
`user.games_block`, `user.games_unblock`.

## The wallet contract (what keeps the money safe)

`backend/src/modules/games/game-wallet.service.ts`, routes in `routes/asadsoft-wallet.ts`.

- **Authentication.**
  - Every call needs `Authorization: Bearer <ASADSOFT_WALLET_TOKEN>`, compared in constant time.
  - A `/debit` or `/credit` also needs `X-Signature` = hex HMAC-SHA256 of the **raw body
    bytes**, keyed on `ASADSOFT_API_SECRET`. The route is mounted before the JSON parser for
    that reason.
  - Authentication failures are rate limited per IP. Legitimate refusals are not.
- **`txId` is the idempotency.**
  - It is the `_id` of `game_wallet_txs`, claimed first inside the transaction that moves the
    diamonds.
  - A retry gets exactly the first answer (a stored 200, never a 4xx), and two identical
    calls in flight move money once.
- **Refusals are remembered.**
  - `INSUFFICIENT_BALANCE` (402), `PLAYER_BLOCKED`, `LEVEL_TOO_LOW`, `GAME_DISABLED`,
    `GAMES_DISABLED`, `PLAYER_INACTIVE` (403) and `PLAYER_NOT_FOUND` (404) are stored under
    the txId, so a retry is refused the same way.
  - AsadSoft rolls the round back on any 4xx.
- **Reversals (`refTxId`).**
  - A reversal returns at most the original's applied amount, once. The original becomes
    `reversed`.
  - A reversal of a txId we never saw stores a **tombstone** under that txId. When the
    original arrives late it is refused with 409 `TX_VOIDED`, so a cancelled stake is never
    charged.
- **Claw-backs** (`reverse:win:`) take what the player still holds and record the rest as
  `shortfall`.
- **Whole diamonds.** Credits are floored, never rounded up. A fractional stake is refused (400).
- **Level.** Game money uses the ledger reasons `game_bet`, `game_payout`, `game_refund`,
  `game_cashback`, `game_reversal`, `game_wallet_deposit` and `game_wallet_withdraw`. None
  moves `stats.*` or level.

| txId prefix | Call | Kind |
|---|---|---|
| `stake:` / `bet:` | debit | stake |
| `win:` | credit | win |
| `refund:` / `cancel:` (+ `refTxId`) | credit | refund |
| `cashback:` / `wager-rebate:` | credit | cashback / rebate |
| `reverse:win:` / `reverse:xfer-out:` (+ `refTxId`) | debit | claw-back |
| `xfer-in:` / `xfer-out:` | debit / credit | transfer wallet |

## Reports

Stats come from `game_player_days` (one row per player per game per day) and
`game_user_stats` (lifetime). Both are written **in the same transaction** as each wallet
call, so they always reconcile to the money. A reversal is netted out of the kind it reverses,
on that kind's day.

- **Turnover** = stakes − stakes refunded.
- **Payouts** = wins − wins clawed back.
- **GGR** = turnover − payouts − cashback. Positive means the platform won, negative means
  players won.
- **RTP** = (payouts + cashback) ÷ turnover.
- **Players** = distinct players with any movement.
- **Transfers** (transfer-wallet mode only): diamonds moved into AsadSoft game wallets and
  back. They are custody, not revenue.

Admin → Games → Overview shows today, yesterday, 7 and 30 days, all time, any range, the daily
chart, per-game figures and the biggest winners and losers. Transactions lists every wallet
call with its full record, filterable by player, game, kind, status, round and time. Players
shows one player's P&L and blocks.

## Purchases feed

After each recharge commits (agent, admin or IAP), the `games.purchase` job reports it to
AsadSoft (`POST /purchases`, keyed on the recharge id). AsadSoft can then report hold against
diamonds actually bought. This is reporting only: it never affects the recharge or a round.

## In the app

- `features/games/game_sheet.dart` hosts the game in `webview_flutter`.
- `game_host_bridge.dart` speaks the provider's host protocol:
  - The game posts events through `window.parent.postMessage`, which is the page itself in a
    WebView, and through `flutter_inappwebview.callHandler`.
  - We inject a `message` listener that forwards the game's events to the `BBGameHost`
    channel, plus a no-op `flutter_inappwebview` stub. The stub makes the game see a host, so
    it never runs its own exit fallback.
- Every way out goes through `REQUEST_EXIT` → `EXIT_REQUEST_ACK` → `EXIT_GAME`, so a player
  with a stake on the live round is asked first.
  - With no answer within 800 ms, the sheet sends `FORCE_END`, blanks the page and closes.
  - The sheet can't be dragged or tapped away.
- Game events:
  - `OPEN_RECHARGE` / `INSUFFICIENT_BALANCE` open the wallet above the sheet.
  - `SESSION_INVALID` and `BOOT_ERROR` offer a relaunch.
  - The balance itself arrives through `wallet:updated`.
- Navigation stays on the game's host, https only in release builds.

## History

Until 2026-11 the app had three in-house games (Golden Wheel, Fortune Ferris, Teen Patti).
Migration `2026-11-13-asadsoft-games` refunded bets of rounds that never settled, then
dropped `game_rounds`, `game_bets` and the old `games` registry. Their ledger rows remain.
