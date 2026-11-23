# Publishing on Google Play

What to fill in, declare and check before submitting BigBoss Live to Google Play. Answers
here match what the code does. If you change a feature, update this page and the legal pages
(`link-web/src/legal/`) together.

## Known risk: read first

Three features are likely to get the app **rejected or removed**, and nothing on this page
fixes them. The owner decided to keep them. They are disclosed honestly in the Terms and the
app.

1. **Games of chance with withdrawable diamonds.** Diamonds bought through Play Billing can be
   staked on AsadSoft games (roulette, teen patti, jackpot, slots), and any diamond can be
   withdrawn as money. Play's
   [Real-Money Gambling policy](https://support.google.com/googleplay/android-developer/answer/9877032)
   forbids staking "in-app items purchased with money" for "a prize of real world monetary
   value" unless the operator is licensed and approved by Google. An approved gambling app
   also can't use Play Billing.
2. **Cash-out of purchased currency.** Play's
   [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)
   says in-app virtual currency may only be used inside the app.
3. **Agent resale of diamonds** outside Play Billing, mentioned inside the app (wallet screen,
   agent screens).

The lowest-risk Play build turns off games (`features.gamesEnabled`), stops withdrawals of
purchased diamonds, and removes the agent paths from the Android app. The date of birth is an
optional profile field and gates nothing: age rests on the 18+ confirmation in the Terms.

## 1. Before the first upload

- [x] **Operator details** in `link-web/src/legal/operator.ts` are filled in (Bangladesh, laws of
  Bangladesh, 6-year financial records, every contact email `developerasad46@gmail.com`).
  `address` and `childSafetyContactName` are optional and left out of the pages while empty.
  Redeploy link-web, then open every page under `https://bigbosslive.ctll.online/legal`.
- [ ] If `app.supportEmail` was ever saved in the admin config, set it to the same address
  (the server and app defaults already use it).
- [ ] **Play App Signing.** After creating the app in Play Console, copy the *app signing* and
  *upload* key fingerprints from Setup → App signing:
  - SHA-1 (both) → Firebase project settings → Android app. Google Sign-In fails without it.
  - SHA-256 (both) → link-web `ANDROID_SHA256_FINGERPRINTS`. App Links fail without it.
- [ ] Build the bundle: `cd app && flutter build appbundle --release`. It fails without
  `android/key.properties`, so it is never signed with the debug key.
- [ ] The old keystore `app/android/app/upload-keystore.jks.old` was in git history (it is
  untracked now). Make sure that key is **not** your upload key. If it is, ask Play support to
  reset the upload key.
- [ ] **Production environment:**
  - `SIGHTGUARD_ENABLED=true` and `SIGHTGUARD_LIVEKIT_CONNECTION_ID` set. Without them every
    image, message and live stream is let through unchecked.
  - `LINK_SERVICE_KEY` is the same on the API and link-web, so the web deletion form is rate
    limited per visitor, not shared by all.
- [ ] Bump `minSupportedBuild.android` (admin config) to the first build with the consent screen
  if older builds are in testers' hands.

## 2. Store listing

- App name **BigBoss Live**, developer name **Bigboss Live** (the legal pages name both).
- Missing assets: 512×512 icon (`app/android/app/icon-source/adaptive-foreground.png` is the
  source art), 1024×500 feature graphic, at least 2 phone screenshots.
- Don't promise earnings ("earn money", "cash", "win"). The listing must match the app.

## 3. App content (Policy → App content)

| Declaration | Answer |
|---|---|
| Privacy policy | `https://bigbosslive.ctll.online/legal/privacy` |
| Ads | No ads |
| App access | Give a reviewer login: a Firebase **test phone number** with a fixed code (Firebase console → Authentication → Sign-in method → Phone). The reviewer accepts the Terms on the consent screen. |
| Target audience | **18 and over only.** Not designed for children. |
| Content rating (IARC) | User interaction: yes. Users can communicate with each other, share location: no, share personal info: yes (profiles, phone numbers in messages). Digital purchases: yes. Simulated gambling: yes (games of chance). Real-money gambling: answer truthfully (staked diamonds can be withdrawn). |
| News app | No |
| Government app | No |
| Financial features | Answer truthfully about withdrawals (payouts to mobile wallets, banks and PayPal). |
| Health | No |
| Foreground services | None declared (the manifest has no `FOREGROUND_SERVICE*` permission). |
| Account deletion URL | `https://bigbosslive.ctll.online/delete-account` |

### Child Safety Standards

The app is in scope (Social category). In Policy → App content → Child safety standards:

- **Published standards:** `https://bigbosslive.ctll.online/legal/child-safety`
- **In-app reporting:** certify yes. Report → "Child sexual exploitation or endangerment" on
  profiles, lives, live chat, private messages, posts and comments, plus Settings → Safety →
  Report a child safety concern.
- **CSAM handling and child-safety laws:** certify yes, and follow the procedure in section 5.
- **Point of contact:** a named person who can act on reports, with
  `developerasad46@gmail.com` (the page's child-safety email).

### Data safety

Data is **encrypted in transit**. Users **can request deletion** (in the app and on the web).
No data is used for advertising and none is sold.

| Data type | Collected | Shared (third party) | Purpose | Optional? |
|---|---|---|---|---|
| Name (display name) | Yes | Games provider | App functionality, account | Required |
| Email address | Yes (Google/Apple sign-in) | No | Account | Optional (depends on sign-in) |
| User IDs | Yes | Games provider, LiveKit | App functionality, fraud prevention | Required |
| Phone number | Yes (phone sign-in) | No | Account | Optional (depends on sign-in) |
| Date of birth | Yes | No | App functionality | Optional |
| Other info: gender, country, bio | Yes | No | App functionality | Optional |
| Financial info: purchase history | Yes | No | App functionality, compliance | Required for purchases |
| Financial info: other (payout account) | Yes | No | Payouts | Optional (withdrawals only) |
| Messages (in-app) | Yes | SightGuard (moderation) | App functionality, safety | Optional |
| Photos | Yes | SightGuard | App functionality, safety | Optional |
| Videos (live video, post videos) | Yes | LiveKit, SightGuard | App functionality, safety | Optional |
| Voice or sound recordings | Yes | LiveKit, SightGuard | App functionality, safety | Optional |
| App interactions | Yes | Games provider (game play) | App functionality, analytics | Required |
| Crash logs, diagnostics | Yes | Firebase Crashlytics | Crash reporting | Required |
| Device or other IDs | Yes (install ID, FCM token) | Firebase | Notifications, fraud prevention | Required |
| Location, contacts, calendar, files, web history, health | No | | | |

Service providers that process data only on our behalf (Firebase, LiveKit, SightGuard,
Cloudflare R2, hosting) may count as "not shared" under Play's definitions. Check each against
Play's guidance before submitting; when in doubt, declare it.

## 4. Permissions

| Permission | Why |
|---|---|
| `CAMERA`, `RECORD_AUDIO` | Going live, joining a stage, voice messages. Asked when used. |
| `BLUETOOTH_CONNECT` | Live audio through Bluetooth headsets. Asked with the microphone, optional. |
| `POST_NOTIFICATIONS` | Push notifications. |
| `WRITE_EXTERNAL_STORAGE` (≤ Android 10) | Saving a chat photo to the gallery. |
| `BILLING` | Play Billing. |

`USE_BIOMETRIC` and `USE_FINGERPRINT` come from a library and are removed in the manifest.
Backups are off (`allowBackup="false"`, `data_extraction_rules.xml`), so the per-install
device ID never moves to another phone.

## 5. Running the safety programme

- **Reports:** admin → Reports. Child-safety reports are marked URGENT, sort first, show a red
  banner, write an error-level `child_safety_report` log line (alert on it), and an audit row
  `report.child_safety`. Each report keeps a snapshot of the reported content.
- **Confirmed CSAM:**
  1. Don't download or share the material. The report snapshot and the stored upload are the
     evidence, and deleting the account keeps media an urgent report points to.
  2. Ban the account and its devices (user page → Ban, Devices → Ban device).
  3. End the live or remove the content.
  4. Report to the NCMEC CyberTipline (`report.cybertip.org`), and to the authorities in your
     country as the law requires. Record the report number in the report's resolution note.
  5. Resolve the report with action `user_banned`.
- **Web deletion requests:** admin → Deletion requests (`accounts.delete`, support and admin
  roles). Verify the requester owns the account (they write from its email, or confirm a
  detail), then Resolve → Delete with the short ID, uid, email or phone. Answer within 30 days,
  as the deletion page promises.
- **Ages:** the date of birth gates nothing; users confirm they are 18+ with the Terms. Reports
  with reason `underage` go to the normal queue: ban accounts that belong to minors.

## 6. New personal developer accounts

Personal accounts created after 13 November 2023 must run a **closed test with at least 12
testers, opted in for 14 days in a row**, before applying for production.

## 7. Updating the legal pages

1. Edit `link-web/src/legal/pages.tsx` and bump `effectiveDate` in `operator.ts`.
2. For a material change, bump `CURRENT_TERMS_VERSION` in `packages/shared/src/constants.ts`
   and `kTermsVersion` in `app/lib/core/config/legal.dart` (a test checks they match). Every
   user then accepts the new version on the consent screen, and the server refuses older app
   builds' consent (409 `terms_outdated`), so raise `minSupportedBuild` at the same time.
