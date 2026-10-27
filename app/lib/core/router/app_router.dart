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
  }
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
    redirect: (context, state) {
      final loc = state.matchedLocation;
      final config = ref.read(appConfigProvider);
      final session = ref.read(sessionProvider);
      final build = ref.read(_buildNumberProvider).value ?? 0;

      if (config.isLoading || session.isLoading) {
        return loc == '/splash' ? null : '/splash';
      }

      final cfg = config.value;
      if (cfg != null) {
        if (cfg.maintenance) return '/maintenance';
        final minBuild = Platform.isIOS ? cfg.minBuildIos : cfg.minBuildAndroid;
        if (build > 0 && build < minBuild) return '/update';
      }

      final err = session.error;
      if (err is ApiException &&
          (err.code == 'account_banned' || err.code == 'device_banned')) {
        return '/banned';
      }
      if (err != null && loc != '/login') return '/login';

      final signedIn = session.value != null;
      final authRoutes = {
        '/splash',
        '/login',
        '/otp',
        '/banned',
        '/maintenance',
        '/update',
      };
      if (!signedIn) return loc == '/login' || loc == '/otp' ? null : '/login';
      if (authRoutes.contains(loc)) return '/home';
      return null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(
        path: '/otp',
        builder: (_, s) => OtpScreen(args: s.extra! as OtpArgs),
      ),
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
          peer: s.extra as UserBrief?,
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
        builder: (_, s) => PostScreen(post: s.extra! as FeedPost),
      ),
    ],
    errorBuilder: (_, s) => Scaffold(
      appBar: AppBar(),
      body: Center(child: Text('Page not found: ${s.uri}')),
    ),
  );
});

/// Map a push / banner deep link (`type` + ids) to a route.
String? routeForLink(Map<String, dynamic> data) {
  final type = data['type'];
  if (type == 'live' && data['roomId'] is String) {
    return '/live/${data['roomId']}';
  }
  if (type == 'chat' && data['conversationId'] is String) {
    return '/chat/${data['conversationId']}';
  }
  if ((type == 'follow' || type == 'like' || type == 'comment') &&
      data['userId'] is String) {
    return '/user/${data['userId']}';
  }
  if (type == 'withdrawal') return '/wallet';
  if (type == 'agency') return '/agency';
  if (type == 'system') return '/notifications';
  final url = data['url'] ?? data['link'];
  if (url is String && url.startsWith('bigboss://')) {
    return url.replaceFirst('bigboss:/', '');
  }
  return null;
}
