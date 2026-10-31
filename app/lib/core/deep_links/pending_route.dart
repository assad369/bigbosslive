import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where the user should land once the app can navigate: a tapped share link or push
/// notification. It survives splash and sign-in (sign in, then the target opens). Only the
/// latest target is kept.
class PendingRoute extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String route) => state = route;

  /// Hands the target over exactly once.
  String? take() {
    final route = state;
    state = null;
    return route;
  }
}

final pendingRouteProvider = NotifierProvider<PendingRoute, String?>(
  PendingRoute.new,
);

enum PendingRouteAction {
  /// Not signed in yet, or the router is still on a boot screen: keep the target for later.
  wait,

  /// Already showing it: drop the target (a repeated tap must not stack a second copy).
  skip,

  /// Push on top of the current screen (Back returns there).
  push,

  /// Leaving the live room on screen for another one: confirm first, then replace it.
  replaceLive,
}

/// Screens a pending target never opens over: the router sends the user on from these.
const _bootPaths = {
  '/splash',
  '/login',
  '/otp',
  '/offline',
  '/banned',
  '/maintenance',
  '/update',
};

/// Pure decision for consuming [PendingRoute], kept separate so it can be unit-tested.
PendingRouteAction decidePendingRoute({
  required bool signedIn,
  required String route,
  required String currentPath,
}) {
  if (!signedIn || _bootPaths.contains(currentPath)) {
    return PendingRouteAction.wait;
  }
  if (currentPath == route) return PendingRouteAction.skip;
  if (route.startsWith('/live/') && currentPath.startsWith('/live/')) {
    return PendingRouteAction.replaceLive;
  }
  return PendingRouteAction.push;
}
