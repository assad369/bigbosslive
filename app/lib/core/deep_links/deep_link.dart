import '../config/env.dart';

/// A share link: `https://<Env.linkHost>/<prefix>/<id>`.
///
/// The URL contract is `DEEP_LINK_ROUTES` in `packages/shared` (also used by link-web and the
/// backend); test/deep_link_test.dart fails if [deepLinkPrefixes] drifts from it. Adding a
/// content type: a subclass here, a case in [parseDeepLink], the shared entry and the
/// Android manifest prefix.
sealed class DeepLink {
  const DeepLink();

  /// Path on the link host, e.g. `/live/65f0…`.
  String get path;

  /// In-app go_router location this link opens.
  String get appRoute;

  /// The URL to share.
  Uri get shareUri => Uri(scheme: 'https', host: Env.linkHost, path: path);

  @override
  bool operator ==(Object other) =>
      other is DeepLink &&
      other.runtimeType == runtimeType &&
      other.path == path;

  @override
  int get hashCode => path.hashCode;

  @override
  String toString() => '$runtimeType($path)';
}

/// A live room, video or party: the room's own type decides the screen.
final class LiveLink extends DeepLink {
  const LiveLink(this.roomId);
  final String roomId;

  @override
  String get path => '/live/$roomId';

  @override
  String get appRoute => '/live/$roomId';
}

/// Profiles are addressed by the short ID shown in the app (the API resolves it).
final class ProfileLink extends DeepLink {
  const ProfileLink(this.shortId);
  final String shortId;

  @override
  String get path => '/u/$shortId';

  @override
  String get appRoute => '/u/$shortId';
}

final class PostLink extends DeepLink {
  const PostLink(this.postId);
  final String postId;

  @override
  String get path => '/post/$postId';

  @override
  String get appRoute => '/post/$postId';
}

/// First path segments this app version understands (mirrors `DEEP_LINK_ROUTES`).
const deepLinkPrefixes = ['live', 'u', 'post'];

final _objectId = RegExp(r'^[a-f0-9]{24}$');

/// `SHORT_ID_PATTERN` in `packages/shared`.
final _shortId = RegExp(r'^\d{3,12}$');

/// Whether [uri] points at our link host at all (links elsewhere are none of our business).
bool isLinkHostUri(Uri uri) =>
    uri.scheme == 'https' && uri.host.toLowerCase() == Env.linkHost;

/// Parses a share link; null when it is not ours or not valid. Query and fragment are
/// ignored, a trailing slash is tolerated, ids must match the contract exactly.
DeepLink? parseDeepLink(Uri uri) {
  if (!isLinkHostUri(uri)) return null;
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (segments.length != 2) return null;
  final [prefix, id] = segments;
  return switch (prefix) {
    'live' when _objectId.hasMatch(id) => LiveLink(id),
    'u' when _shortId.hasMatch(id) => ProfileLink(id),
    'post' when _objectId.hasMatch(id) => PostLink(id),
    _ => null,
  };
}
