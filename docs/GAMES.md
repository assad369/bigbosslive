# Games & fairness

Three server-authoritative betting games share one round engine
(`backend/src/modules/games`): **Golden Wheel**, **Fortune Ferris** and **Teen Patti**. The
front-ends in `games/` only render state and place bets.

## Round lifecycle

```
betting ──(bettingEndsAt)──▶ locked ──(settlesAt)──▶ settled ──▶ next round opens
   bets accepted              outcome computed,          payouts credited,
   (REST, idempotent)          animation plays            seed revealed
```

The `games.tick` job runs every second. Each transition is a conditional update, so concurrent
ticks are harmless. Settlement is per bet: `placed → won/lost` is conditional, and the payout
credit happens in the same transaction, so a crash mid-settlement resumes without paying
twice. An admin can **void** a stuck round, which refunds every placed bet.

## Provably fair (commit–reveal)

1. At round start the server generates a random 32-byte `serverSeed` and publishes
   `serverSeedHash = sha256(serverSeed)`.
2. Bets are placed against that commitment.
3. After settlement, `serverSeed` is revealed (`GET /v1/games/rounds/:id/verify`).
4. Anyone can check `sha256(serverSeed) == serverSeedHash` and recompute the outcome:
   - floats: `HMAC_SHA256(key = serverSeed, msg = "<game>:<roundNo>:<n>")`, read as 6-byte
     big-endian integers ÷ 2⁴⁸ (five floats per digest, `n = 0, 1, …`)
   - **Golden Wheel / Fortune Ferris**: the first float picks an option from the weight table
     (cumulative weights, in payout-table order).
   - **Teen Patti**: the 52-card deck (ranks `2…A`, suits `s h d c`) is Fisher–Yates shuffled
     with the first 52 floats. Seats A, B and C get cards 0–2, 3–5 and 6–8. The best hand
     wins; exact ties go to the highest suit of the top card.

## Return to player

For the weighted games, the default weights are ∝ 1/multiplier, which gives every option the
same RTP:

| Game | Payouts | RTP |
|---|---|---|
| Golden Wheel | 👑×45 💎×25 💍×15 🪙×10, four fruits ×5 | 96.2–97.7% (weights rounded to integers) |
| Fortune Ferris | Phoenix×40 Dragon×20 Tiger×10 Koi×8, four ×5 | ≈ 90.9% |
| Teen Patti | each seat ×2.9 (1⁄3 chance) | ≈ 96.7% |

Admins can tune payouts, weights, timings, bet limits and chips (Admin → Games). The API
rejects weighted configs whose RTP exceeds 100% for any option. Admin → Games → Analytics shows
the realised RTP per day alongside the theoretical value.

## Limits

`minBet`, `maxBet` and a per-user `maxRoundStake` per round, checked inside the bet
transaction. Bets are idempotent (`Idempotency-Key`) and rate-limited per user.
