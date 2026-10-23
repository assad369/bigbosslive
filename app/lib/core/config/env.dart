/// Build-time configuration, passed with `--dart-define` (see app/README.md).
abstract final class Env {
  /// API origin, e.g. https://api.bigbosslive.app (no trailing slash).
  static const apiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:3000',
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

  /// Firebase Auth emulator host:port for local development, e.g. 10.0.2.2:9099.
  static const authEmulator = String.fromEnvironment('AUTH_EMULATOR');
}
