import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../data/repositories.dart';
import '../models/models.dart';
import 'iap/iap_service.dart';
import 'network/api_client.dart';
import 'network/api_exception.dart';
import 'push/push_service.dart';
import 'realtime/socket_service.dart';

/// Riverpod retries failed providers 10 times by default, holding them in a loading state for
/// ~40 s. A ban or a validation error will not change on retry, so only network failures
/// (no response at all) are retried, and briefly.
Duration? providerRetry(int retryCount, Object error) {
  if (error is ApiException && error.isNetwork && retryCount < 3) {
    return Duration(milliseconds: 500 * (1 << retryCount));
  }
  return null;
}

/// Overridden in `main.dart` once the persisted device id is loaded.
final deviceIdProvider = Provider<String>(
  (ref) => throw UnimplementedError('deviceIdProvider must be overridden'),
);

final apiProvider = Provider<ApiClient>(
  (ref) => ApiClient(deviceId: ref.watch(deviceIdProvider)),
);

final accountRepo = Provider(
  (ref) => AccountRepository(ref.watch(apiProvider)),
);
final contentRepo = Provider(
  (ref) => ContentRepository(ref.watch(apiProvider)),
);
final liveRepo = Provider((ref) => LiveRepository(ref.watch(apiProvider)));
final economyRepo = Provider(
  (ref) => EconomyRepository(ref.watch(apiProvider)),
);
final socialRepo = Provider((ref) => SocialRepository(ref.watch(apiProvider)));
final agencyRepo = Provider((ref) => AgencyRepository(ref.watch(apiProvider)));

/// Remote config, readable before sign-in (maintenance mode, force update, feature flags).
final appConfigProvider = FutureProvider<AppConfig>(
  (ref) => ref.watch(contentRepo).appConfig(),
);

/// Sign-in and sign-out only. Token refreshes must not rebuild the session: every rebuild
/// passes through a loading state, which the router would treat as "booting".
final firebaseUserProvider = StreamProvider<User?>(
  (ref) => FirebaseAuth.instance.authStateChanges(),
);

/// The signed-in user's profile. `null` = signed out. Errors carry the server's reason
/// (e.g. `account_banned`), which the router turns into the right screen.
final sessionProvider = AsyncNotifierProvider<SessionController, MeUser?>(
  SessionController.new,
);

class SessionController extends AsyncNotifier<MeUser?> {
  @override
  Future<MeUser?> build() async {
    final user = await ref.watch(firebaseUserProvider.future);
    if (user == null) return null;
    return ref.read(accountRepo).session(displayName: user.displayName);
  }

  Future<void> refresh() async {
    final next = await AsyncValue.guard(() => ref.read(accountRepo).me());
    if (next.hasValue) state = next;
  }

  void replace(MeUser me) => state = AsyncData(me);

  /// Device-bound state (the push token) is torn down while the ID token is still valid;
  /// after Firebase signs out, those calls would be rejected as unauthenticated.
  Future<void> signOut() async {
    ref.read(iapProvider).stop();
    await ref.read(pushProvider).stop();
    try {
      await GoogleSignIn.instance.signOut();
    } catch (e) {
      debugPrint('google sign-out failed: $e');
    }
    await FirebaseAuth.instance.signOut();
  }
}

/// The signed-in uid. Providers holding per-account data watch this so they reset when the
/// account changes.
final sessionUidProvider = Provider<String?>(
  (ref) => ref.watch(sessionProvider.select((s) => s.value?.id)),
);

final pushProvider = Provider<PushService>(
  (ref) => PushService(ref.watch(accountRepo)),
);

/// In-app purchases for the app's lifetime; see [IapService].
final iapProvider = Provider<IapService>((ref) {
  final iap = IapService(
    gateway: StorePurchaseGateway(isAndroid: Platform.isAndroid),
    repo: () => ref.read(economyRepo),
    onCredited: () => ref.read(sessionProvider.notifier).refresh(),
    isAndroid: Platform.isAndroid,
  );
  ref.onDispose(iap.dispose);
  return iap;
});

/// Convenience: the current user or throws (use only below the auth gate).
final meProvider = Provider<MeUser>((ref) {
  final me = ref.watch(sessionProvider).value;
  if (me == null) {
    throw const ApiException(401, 'unauthorized', 'Not signed in');
  }
  return me;
});

final socketProvider = Provider<SocketService>((ref) {
  final socket = SocketService();
  ref.onDispose(socket.dispose);
  ref.listen(sessionUidProvider, (prev, uid) {
    if (uid == null || (prev != null && prev != uid)) socket.disconnect();
    if (uid != null) socket.connect();
  }, fireImmediately: true);
  return socket;
});

/// Badge counts for the bottom navigation; refreshed by socket events.
final unreadProvider = FutureProvider<({int notifications, int chat})>((
  ref,
) async {
  if (ref.watch(sessionUidProvider) == null) {
    return (notifications: 0, chat: 0);
  }
  final socket = ref.watch(socketProvider);
  final sub = socket.events
      .where((e) => e.name == 'chat:message' || e.name == 'notification:new')
      .listen((_) => ref.invalidateSelf());
  ref.onDispose(sub.cancel);
  return ref.watch(socialRepo).unreadCounts();
});
