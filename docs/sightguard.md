# SightGuard moderation

BigBoss Live sends user content to SightGuard, our self-hosted moderation platform, and acts on
its verdicts. Nothing is sent until `SIGHTGUARD_ENABLED=true`.

## What is checked

Uploads go from the app straight to R2, so the API never sees the bytes. Images are checked
**by URL** when the URL is saved, and SightGuard fetches them from the public bucket URL.
Profile and room fields are only checked when they change.

Avatars may be animated GIFs (`UPLOAD_KINDS.avatar`). The URL is sent as is, so the
SightGuard `avatar` policy must accept `image/gif`: because avatars fail closed, a GIF the
service can't read is refused instead of published.

| Where | Channel (SightGuard policy) | When rejected | When SightGuard is down |
|---|---|---|---|
| Avatar (`PATCH /v1/me`) | `avatar` | 422 `content_rejected` | **refused**: 503 `moderation_unavailable` (fail closed) |
| Live cover and background (`POST /v1/live`, `PATCH /v1/live/:id`) | `live_cover` | refused | **refused** |
| Feed post images | `post_image` | refused | allowed |
| DM images | `chat_media` | refused | allowed |
| Feed post videos | `post_video` (async) | post removed after the check | allowed |
| Live chat | `live_chat` | refused | allowed (time budget `SIGHTGUARD_CHAT_TIMEOUT_MS`) |
| Live title | `live_title` | refused | allowed |
| Feed post text and comments | `post_text`, `comment` | refused | allowed |
| Private messages | `private_chat` | refused | allowed |
| Display name and bio | `username`, `bio` | refused | allowed |
| Live video, on-screen text and speech | `live_stream` | see below | stream continues |

The local word filter (`modules/moderation`) still runs first.

A `review` decision publishes the content right away. If a moderator later rejects it in the
SightGuard review queue, the `review.completed` webhook undoes it:

- posts, comments, DMs and live chat messages are removed
- an avatar or live cover is cleared, but only if it is still the one that was checked
- a display name is reset to `Boss<shortId>` and a bio is cleared
- the author is notified

Undoing works because every check sends a content ref as metadata, which SightGuard echoes back
on the webhook.

## Live streams

Going live registers the LiveKit room with SightGuard, and ending the live unregisters it. Both
calls run as `sightguard.live` jobs with retries, so they never block or fail a live.
SightGuard's live agent joins as a hidden subscriber and escalates according to the
`live_stream` policy.

| SightGuard action | BigBoss effect |
|---|---|
| `warn` | in-room notice to the participant, plus an inbox notification |
| `mute_track` | camera off (visual or on-screen text) or microphone off (speech), enforced on the SFU. A seated guest's seat flag is set too. |
| `remove_participant` | the participant is removed and banned from that host's rooms for 30 minutes. If it is the host, the live is ended instead. |
| `end_room` | the live ends with reason `moderation`. It also bans the user, but only with `SIGHTGUARD_AUTO_BAN=true` and `recommendBan` set. |

During a PK battle, the opponent's video is forwarded into the room. A violation by the
opponent is applied to the opponent's own live.

Automatic bans are off by default, so a moderator confirms every ban. Staff accounts are never
auto-banned. Every automated action is in the audit log under `adminId: system`.

## Setup

1. In the SightGuard dashboard, create the project **BigBoss Live** and an API key with the
   scopes `moderate:image`, `moderate:text`, `moderate:video` and `live:write`.
2. Under **Webhooks**, add `https://<api-host>/v1/webhooks/sightguard` with the events
   `live.violation`, `video.completed` and `review.completed`. Copy the signing secret.
3. Under **LiveKit**, add the LiveKit project with the same URL, key and secret as `LIVEKIT_*`.
   - Set the room pattern to `^bb_[A-Za-z0-9]+_[0-9]+$`.
   - Leave auto-monitor **off**: BigBoss registers its rooms itself, and the pattern keeps other
     apps' rooms on a shared LiveKit project out.
   - Copy the connection id.
4. The bucket's public URL (`S3_PUBLIC_BASE_URL` or Settings → Storage) must be reachable from
   the SightGuard servers, because SightGuard downloads images and videos from there.
5. Set these on every API and worker replica:
   ```
   SIGHTGUARD_ENABLED=true
   SIGHTGUARD_API_URL=https://moderation-api.example.com
   SIGHTGUARD_API_KEY=sg_live_…
   SIGHTGUARD_WEBHOOK_SECRET=whsec_…
   SIGHTGUARD_LIVEKIT_CONNECTION_ID=lkc_…
   ```
   Optional: `SIGHTGUARD_CHAT_TIMEOUT_MS` (default 300) and `SIGHTGUARD_AUTO_BAN` (default false).
6. Tune thresholds per channel in the SightGuard dashboard (Policies). Changes apply within
   seconds, with no deploy.

The server refuses to boot when `SIGHTGUARD_ENABLED=true` but the URL, key or secret is missing.

## Updating the SDK

The SDK is vendored as `backend/vendor/sightguard-sdk-<version>.tgz`, so Docker builds need no
private registry. To update it:

1. In the SightGuard repo, run
   `pnpm --filter @sightguard/sdk build && pnpm --filter @sightguard/sdk pack --pack-destination <bigbosslive>/backend/vendor`.
2. From the BigBoss repo root, run `npm install ./backend/vendor/sightguard-sdk-<version>.tgz -w backend`.
3. Delete the old tarball.
