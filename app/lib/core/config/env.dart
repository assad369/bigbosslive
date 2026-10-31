/// Build-time configuration, passed with `--dart-define` (see app/README.md).
abstract final class Env {
  /// API origin (no trailing slash). Every build mode uses production unless `API_URL`
  /// overrides it, e.g. `--dart-define=API_URL=http://10.0.2.2:3000` for a local backend.
  static const apiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'https://bigbossapi.asadsoft.cloud',
  );

  /// Google OAuth web client id (server client id) for Google Sign-In.
  static const googleServerClientId = String.fromEnvironment(
    'GOOGLE_SERVER_CLIENT_ID',
  );

  /// Privacy / terms fallbacks used before remote config loads.
  static const privacyUrl = String.fromEnvironment(
    'PRIVACY_URL',
    defaultValue: 'https://bigbosslive.app/privacy',
  );
  static const termsUrl = String.fromEnvironment(
    'TERMS_URL',
    defaultValue: 'https://bigbosslive.app/terms',
  );

  /// Numeric App Store id, used by the force-update screen on iOS.
  static const iosAppStoreId = String.fromEnvironment('IOS_APP_STORE_ID');

  /// Android application id, used by the force-update screen.
  static const androidPackage = String.fromEnvironment(
    'ANDROID_PACKAGE',
    defaultValue: 'com.bigbosslive.bigboss_live',
  );

  /// Host of the share links (`https://<host>/live/<id>`), served by link-web and claimed by
  /// the app (Android App Links, iOS Universal Links). Set it per deployment; the Android
  /// manifest and the iOS entitlements read the same define at build time.
  static const linkHost = String.fromEnvironment(
    'LINK_HOST',
    defaultValue: 'links.example.com',
  );

  /// Firebase Auth emulator host:port for local development, e.g. 10.0.2.2:9099.
  static const authEmulator = String.fromEnvironment('AUTH_EMULATOR');
}
