# BigBoss Live — mobile app

Flutter app (Android & iOS) for BigBoss Live. Riverpod for state, go_router for navigation,
dio for the REST API, Socket.IO for personal realtime events, LiveKit for live video/audio,
Firebase for auth, push and crash reporting. The UI uses the **Champagne** design system in
`lib/core/theme/` (mirrors `packages/shared/src/theme.ts`).

## Structure

```
lib/
  main.dart / app.dart        bootstrap (Firebase, Crashlytics, device id) and MaterialApp.router
  core/
    config/env.dart           --dart-define build configuration
    theme/                    BBColors tokens + BBTheme (never inline hex values)
    network/                  ApiClient (auth/device headers, 401 refresh, retries), ApiException
    realtime/                 SocketService (chat, notifications, wallet, live directory)
    push/                     FCM registration + foreground notifications + tap routing
    router/app_router.dart    routes, auth/maintenance/force-update/ban redirects, deep links
    widgets/                  GoldButton, BBAvatar, LevelBadge, VipBadge, PagedList, AsyncView…
    providers.dart            repositories, session (AsyncNotifier), socket, unread counts
  data/repositories.dart      typed API wrappers per domain
  models/models.dart          immutable models with strict-cast-safe fromJson
  features/                   auth, home, live (room, gifts, PK, seats), chat, feed, profile,
                              wallet (IAP, ledger, withdrawals, agent), store/VIP, agency,
                              games (WebView bridge), leaderboard, notifications
```

## Setup

1. **Firebase**: create Android (`com.bigbosslive.bigboss_live`) and iOS apps in the Firebase
   project the backend uses. Download `google-services.json` → `android/app/` and
   `GoogleService-Info.plist` → `ios/Runner/` (both git-ignored). Enable Google, Apple and
   Phone sign-in providers. Add your SHA-1/SHA-256 fingerprints for Google/phone sign-in.
2. **iOS**: set the deployment target to iOS 15+ in Xcode and `ios/Podfile`
   (`platform :ios, '15.0'`), enable the *Push Notifications*, *Sign in with Apple* and
   *Background Modes → Audio, Remote notifications* capabilities, and upload your APNs key to
   Firebase.
3. **Store products**: create consumable products whose ids match the backend recharge
   package SKUs (`diamonds_100`, `diamonds_520`, …).
4. **Release signing (Android)**: create `android/key.properties` (git-ignored):
   ```
   storeFile=/absolute/path/upload-keystore.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```

## Run

```bash
flutter pub get
flutter run \
  --dart-define=API_URL=https://api.bigbosslive.app \
  --dart-define=GOOGLE_SERVER_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
```

Local backend from the Android emulator: `--dart-define=API_URL=http://10.0.2.2:3000`
(the default). Firebase Auth emulator: `--dart-define=AUTH_EMULATOR=10.0.2.2:9099`.

## Quality

```bash
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

## Release

```bash
flutter build appbundle --release --obfuscate --split-debug-info=build/symbols --dart-define=API_URL=…
flutter build ipa --release --obfuscate --split-debug-info=build/symbols --dart-define=API_URL=…
```

Upload `build/symbols` to Crashlytics so obfuscated stack traces are readable.
