import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/repositories.dart';
import '../models/models.dart';
import 'network/api_client.dart';
import 'network/api_exception.dart';
import 'realtime/socket_service.dart';

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

final firebaseUserProvider = StreamProvider<User?>(
  (ref) => FirebaseAuth.instance.idTokenChanges(),
);

/// The signed-in user's profile. `null` = signed out. Errors carry the server's reason
/// (e.g. `account_banned`), which the router turns into the right screen.
final sessionProvider = AsyncNotifierProvider<SessionController, MeUser?>(
  SessionController.new,
);

class SessionController extends AsyncNotifier<MeUser?> {
  String? _uid;

  @override
  Future<MeUser?> build() async {
    final user = await ref.watch(firebaseUserProvider.future);
    if (user == null) {
      _uid = null;
      return null;
    }
    // Token refreshes re-fire the stream; only bootstrap the session when the uid changes.
    if (_uid == user.uid && state.hasValue && state.value != null) {
      return state.value;
    }
    _uid = user.uid;
    return ref.read(accountRepo).session(displayName: user.displayName);
  }

  Future<void> refresh() async {
    final next = await AsyncValue.guard(() => ref.read(accountRepo).me());
    if (next.hasValue) state = next;
  }

  void replace(MeUser me) => state = AsyncData(me);

  Future<void> signOut() async {
    await FirebaseAuth.instance.signOut();
  }
}

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
  ref.listen(sessionProvider, (_, next) {
    if (next.value != null) {
      socket.connect();
    } else {
      socket.disconnect();
    }
  }, fireImmediately: true);
  return socket;
});

/// Badge counts for the bottom navigation; refreshed by socket events.
final unreadProvider = FutureProvider<({int notifications, int chat})>((
  ref,
) async {
  final socket = ref.watch(socketProvider);
  final sub = socket.events
      .where((e) => e.name == 'chat:message' || e.name == 'notification:new')
      .listen((_) => ref.invalidateSelf());
  ref.onDispose(sub.cancel);
  return ref.watch(socialRepo).unreadCounts();
});
