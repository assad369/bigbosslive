import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../features/agency/agency_screen.dart';
import '../../features/auth/auth_screens.dart';
import '../../features/chat/chat_screens.dart';
import '../../features/feed/feed_screens.dart';
import '../../features/games/games_screens.dart';
import '../../features/home/home_shell.dart';
import '../../features/home/live_list_screen.dart';
import '../../features/leaderboard/leaderboard_screen.dart';
import '../../features/live/go_live_screen.dart';
import '../../features/live/live_room_screen.dart';
import '../../features/notifications/notifications_screen.dart';
import '../../features/profile/profile_screens.dart';
import '../../features/store/store_screens.dart';
import '../../features/wallet/wallet_screens.dart';
import '../../models/models.dart';
import '../network/api_exception.dart';
import '../providers.dart';

/// Bridges Riverpod state into go_router's `refreshListenable`.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(sessionProvider, (_, _) => notifyListeners());
    ref.listen(appConfigProvider, (_, _) => notifyListeners());
    ref.listen(_buildNumberProvider, (_, _) => notifyListeners());
  }
}

/// Still booting: nothing to decide on yet. A reload that already has a value (or an error)
/// is not booting, or every refresh would bounce the user through the splash screen and drop
/// their whole navigation stack, live room included.
bool _booting(AsyncValue<Object?> v) =>
    v.isLoading && !v.hasValue && !v.hasError;

const _bootRoutes = {
  '/splash',
  '/login',
  '/otp',
  '/offline',
  '/banned',
  '/maintenance',
  '/update',
};

/// Pure redirect rules, kept separate from go_router so they can be tested directly.
@visibleForTesting
String? redirectFor({
  required String location,
  required AsyncValue<AppConfig> config,
  required AsyncValue<MeUser?> session,
  required int build,
  required bool isIOS,
}) {
  if (_booting(config) || _booting(session)) {
    return location == '/splash' ? null : '/splash';
  }

  final cfg = config.value;
  if (cfg != null) {
    if (cfg.maintenance) return '/maintenance';
    final minBuild = isIOS ? cfg.minBuildIos : cfg.minBuildAndroid;
    if (build > 0 && build < minBuild) return '/update';
  }

  final err = session.error;
  if (err is ApiException &&
      (err.code == 'account_banned' || err.code == 'device_banned')) {
    return '/banned';
  }
  if (err != null && !session.hasValue) {
    // Only an auth failure means signing in again. Anything else (offline, server down) keeps
    // the Firebase session and offers a retry.
    if (err is ApiException && err.isUnauthorized) {
      return location == '/login' || location == '/otp' ? null : '/login';
    }
    return '/offline';
  }

  final signedIn = session.value != null;
  if (!signedIn) {
    return location == '/login' || location == '/otp' ? null : '/login';
  }
  if (_bootRoutes.contains(location)) return '/home';
  return null;
}

final _buildNumberProvider = FutureProvider<int>(
  (ref) async =>
      int.tryParse((await PackageInfo.fromPlatform()).buildNumber) ?? 0,
);

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: '/splash',
    refreshListenable: refresh,
    debugLogDiagnostics: kDebugMode,
    redirect: (context, state) => redirectFor(
      location: state.matchedLocation,
      config: ref.read(appConfigProvider),
      session: ref.read(sessionProvider),
      build: ref.read(_buildNumberProvider).value ?? 0,
      isIOS: Platform.isIOS,
    ),
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      // Screens that need an in-memory `extra` redirect away when opened without one
      // (deep link, process restore) instead of crashing.
      GoRoute(
        path: '/otp',
        redirect: (_, s) => s.extra is OtpArgs ? null : '/login',
        builder: (_, s) => OtpScreen(args: s.extra! as OtpArgs),
      ),
      GoRoute(path: '/offline', builder: (_, _) => const OfflineScreen()),
      GoRoute(path: '/banned', builder: (_, _) => const BannedScreen()),
      GoRoute(
        path: '/maintenance',
        builder: (_, _) => const MaintenanceScreen(),
      ),
      GoRoute(path: '/update', builder: (_, _) => const ForceUpdateScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/home', builder: (_, _) => const LiveListScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/feed', builder: (_, _) => const FeedScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/messages',
                builder: (_, _) => const InboxScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/me', builder: (_, _) => const MeScreen())],
          ),
        ],
      ),
      GoRoute(path: '/go-live', builder: (_, _) => const GoLiveScreen()),
      GoRoute(
        path: '/live/:id',
        // `extra` is the host's own session right after going live, or the password a
        // viewer entered for a locked room.
        builder: (_, s) => LiveRoomScreen(
          roomId: s.pathParameters['id']!,
          hostSession: s.extra is LiveSession ? s.extra! as LiveSession : null,
          password: s.extra is RoomPassword
              ? (s.extra! as RoomPassword).value
              : null,
        ),
      ),
      GoRoute(
        path: '/user/:uid',
        builder: (_, s) => UserProfileScreen(uid: s.pathParameters['uid']!),
      ),
      // A shared profile link carries the short ID people see; the profile itself is
      // addressed by uid.
      GoRoute(
        path: '/u/:shortId',
        builder: (_, s) =>
            UserByShortIdScreen(shortId: s.pathParameters['shortId']!),
      ),
      GoRoute(
        path: '/user/:uid/:direction(followers|following)',
        builder: (_, s) => FollowListScreen(
          uid: s.pathParameters['uid']!,
          direction: s.pathParameters['direction']!,
        ),
      ),
      GoRoute(
        path: '/chat/:id',
        builder: (_, s) => ConversationScreen(
          conversationId: s.pathParameters['id']!,
          peer: s.extra is UserBrief ? s.extra! as UserBrief : null,
          peerId: s.uri.queryParameters['peer'],
        ),
      ),
      GoRoute(path: '/search', builder: (_, _) => const SearchScreen()),
      GoRoute(path: '/wallet', builder: (_, _) => const WalletScreen()),
      GoRoute(path: '/wallet/ledger', builder: (_, _) => const LedgerScreen()),
      GoRoute(
        path: '/wallet/withdraw',
        builder: (_, _) => const WithdrawScreen(),
      ),
      GoRoute(path: '/agent', builder: (_, _) => const AgentRechargeScreen()),
      GoRoute(path: '/store', builder: (_, _) => const StoreScreen()),
      GoRoute(path: '/vip', builder: (_, _) => const VipScreen()),
      GoRoute(path: '/agency', builder: (_, _) => const AgencyScreen()),
      GoRoute(
        path: '/notifications',
        builder: (_, _) => const NotificationsScreen(),
      ),
      GoRoute(path: '/games', builder: (_, _) => const GamesScreen()),
      GoRoute(
        path: '/games/play',
        redirect: (_, s) => s.extra is GameInfo ? null : '/games',
        builder: (_, s) => GameWebViewScreen(game: s.extra! as GameInfo),
      ),
      GoRoute(
        path: '/leaderboard',
        builder: (_, _) => const LeaderboardScreen(),
      ),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      GoRoute(
        path: '/settings/profile',
        builder: (_, _) => const EditProfileScreen(),
      ),
      GoRoute(
        path: '/settings/blocked',
        builder: (_, _) => const BlockedUsersScreen(),
      ),
      GoRoute(path: '/history', builder: (_, _) => const LiveHistoryScreen()),
      GoRoute(path: '/post/new', builder: (_, _) => const CreatePostScreen()),
      GoRoute(
        path: '/post/:id',
        builder: (_, s) => s.extra is FeedPost
            ? PostScreen(post: s.extra! as FeedPost)
            : PostByIdScreen(postId: s.pathParameters['id']!),
      ),
    ],
    errorBuilder: (_, s) => Scaffold(
      appBar: AppBar(),
      body: Center(child: Text('Page not found: ${s.uri}')),
    ),
  );
});

/// First path segments a `bigboss://` link may open. Anything else (auth screens, screens
/// that need in-memory arguments) is ignored rather than navigated to.
const _linkableRoots = {
  'home',
  'feed',
  'messages',
  'me',
  'live',
  'user',
  'chat',
  'post',
  'wallet',
  'store',
  'vip',
  'agency',
  'notifications',
  'games',
  'leaderboard',
  'search',
  'history',
};

/// Map a push / banner deep link (`type` + ids) to a route.
String? routeForLink(Map<String, dynamic> data) {
  final type = data['type'];
  if (type == 'live' && data['roomId'] is String) {
    return '/live/${Uri.encodeComponent(data['roomId'] as String)}';
  }
  if (type == 'chat' && data['conversationId'] is String) {
    final id = Uri.encodeComponent(data['conversationId'] as String);
    final sender = data['senderId'];
    // The peer's uid lets the conversation screen load who it's talking to.
    return sender is String && sender.isNotEmpty
        ? '/chat/$id?peer=${Uri.encodeQueryComponent(sender)}'
        : '/chat/$id';
  }
  if ((type == 'follow' || type == 'like' || type == 'comment') &&
      data['userId'] is String) {
    return '/user/${Uri.encodeComponent(data['userId'] as String)}';
  }
  if (type == 'withdrawal') return '/wallet';
  if (type == 'agency') return '/agency';
  if (type == 'system') return '/notifications';
  final url = data['url'] ?? data['link'];
  if (url is! String) return null;
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'bigboss' || uri.host.isEmpty) return null;
  if (!_linkableRoots.contains(uri.host)) return null;
  final segments = [uri.host, ...uri.pathSegments.where((p) => p.isNotEmpty)];
  if (segments.length > 1 && segments[0] == 'games') return '/games';
  final path = '/${segments.map(Uri.encodeComponent).join('/')}';
  return uri.hasQuery ? '$path?${uri.query}' : path;
}
