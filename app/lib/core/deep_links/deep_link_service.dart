import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../router/app_router.dart';
import 'deep_link.dart';
import 'pending_route.dart';

/// Message for a link on our host that this app version can't open (e.g. a newer content
/// type).
class UnsupportedLink extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String? message) => state = message;
}

final unsupportedLinkProvider = NotifierProvider<UnsupportedLink, String?>(
  UnsupportedLink.new,
);

/// Receives App Links / Universal Links (and `bigboss://` links) and queues their target in
/// [pendingRouteProvider].
///
/// `uriLinkStream` alone covers cold start (the launch link is replayed to the first
/// listener), warm start and links arriving while the app is open; calling
/// `getInitialLink()` as well would deliver the launch link twice. OS-level re-deliveries of
/// the same link are dropped.
class DeepLinkService {
  DeepLinkService(this._ref, {this._links, DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final Ref _ref;
  final Stream<Uri>? _links;
  final DateTime Function() _clock;
  StreamSubscription<Uri>? _sub;
  Uri? _last;
  DateTime? _lastAt;

  static const dedupeWindow = Duration(seconds: 3);

  void start() {
    if (_sub != null) return;
    final links = _links ?? AppLinks().uriLinkStream;
    _sub = links.listen(
      handle,
      onError: (Object e) => debugPrint('deep link error: $e'),
    );
  }

  void handle(Uri uri) {
    final custom = uri.scheme == 'bigboss';
    if (!custom && !isLinkHostUri(uri)) return;
    final now = _clock();
    if (uri == _last &&
        _lastAt != null &&
        now.difference(_lastAt!) < dedupeWindow) {
      return;
    }
    _last = uri;
    _lastAt = now;
    final route = custom
        ? routeForLink({'url': uri.toString()})
        : parseDeepLink(uri)?.appRoute;
    if (route == null) {
      _ref
          .read(unsupportedLinkProvider.notifier)
          .set('This link can’t be opened. Update BigBoss Live and try again.');
      return;
    }
    _ref.read(pendingRouteProvider.notifier).set(route);
  }

  Future<void> dispose() async => _sub?.cancel();
}

final deepLinkServiceProvider = Provider<DeepLinkService>((ref) {
  final service = DeepLinkService(ref);
  ref.onDispose(service.dispose);
  return service;
});
