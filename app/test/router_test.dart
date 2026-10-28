import 'dart:async';

import 'package:bigboss_live/core/network/api_exception.dart';
import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/router/app_router.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final _me = MeUser.fromJson({
  'id': 'u1',
  'shortId': '201',
  'displayName': 'Boss',
  'wallet': {'diamonds': 1},
  'levelProgress': {'level': 1},
});

final _config = AppConfig.fromJson({
  'app': {
    'minSupportedBuild': {'android': 5, 'ios': 3},
  },
});

/// A provider that has a value and is loading again, as after a dependency changed. Built
/// through a real container because `copyWithPrevious` is internal to Riverpod.
Future<AsyncValue<T>> _reloading<T>(T value) async {
  final container = ProviderContainer();
  addTearDown(container.dispose);
  var first = true;
  final never = Completer<T>();
  final p = FutureProvider<T>((ref) {
    if (!first) return never.future;
    first = false;
    return Future.value(value);
  });
  container.listen(p, (_, _) {});
  await container.read(p.future);
  container.invalidate(p);
  return container.read(p);
}

String? _redirect(
  String location, {
  AsyncValue<AppConfig>? config,
  required AsyncValue<MeUser?> session,
  int build = 10,
  bool isIOS = false,
}) => redirectFor(
  location: location,
  config: config ?? AsyncData(_config),
  session: session,
  build: build,
  isIOS: isIOS,
);

void main() {
  group('redirectFor', () {
    test('boots on the splash screen until there is something to decide', () {
      expect(_redirect('/live/r1', session: const AsyncLoading()), '/splash');
      expect(
        _redirect(
          '/home',
          config: const AsyncLoading(),
          session: AsyncData(_me),
        ),
        '/splash',
      );
      expect(_redirect('/splash', session: const AsyncLoading()), isNull);
    });

    test('a session reload keeps the user where they are', () async {
      // Regression: every token refresh used to bounce through /splash to /home, dropping
      // the navigation stack and with it the live room.
      final session = await _reloading<MeUser?>(_me);
      expect(session.isLoading, isTrue);
      expect(session.hasValue, isTrue);
      expect(_redirect('/live/r1', session: session), isNull);

      final config = await _reloading<AppConfig>(_config);
      expect(
        _redirect('/chat/c1', config: config, session: AsyncData(_me)),
        isNull,
      );
    });

    test('signed-out users go to login and stay on the auth screens', () {
      const out = AsyncData<MeUser?>(null);
      expect(_redirect('/home', session: out), '/login');
      expect(_redirect('/login', session: out), isNull);
      expect(_redirect('/otp', session: out), isNull);
    });

    test('signed-in users leave the boot screens for home', () {
      for (final loc in ['/splash', '/login', '/offline', '/maintenance']) {
        expect(_redirect(loc, session: AsyncData(_me)), '/home');
      }
      expect(_redirect('/wallet', session: AsyncData(_me)), isNull);
    });

    test('bans go to the banned screen', () {
      for (final code in ['account_banned', 'device_banned']) {
        expect(
          _redirect(
            '/home',
            session: AsyncError(ApiException(403, code, 'x'), StackTrace.empty),
          ),
          '/banned',
        );
      }
    });

    test('a network or server failure offers a retry, not a new sign-in', () {
      expect(
        _redirect(
          '/splash',
          session: const AsyncError(
            ApiException(0, 'network', 'offline'),
            StackTrace.empty,
          ),
        ),
        '/offline',
      );
      expect(
        _redirect(
          '/splash',
          session: const AsyncError(
            ApiException(503, 'error', 'down'),
            StackTrace.empty,
          ),
        ),
        '/offline',
      );
      expect(
        _redirect(
          '/splash',
          session: const AsyncError(
            ApiException(401, 'unauthorized', 'no'),
            StackTrace.empty,
          ),
        ),
        '/login',
      );
    });

    test('maintenance and minimum build are enforced per platform', () {
      final maintenance = AppConfig.fromJson({
        'app': {'maintenance': true},
      });
      expect(
        _redirect(
          '/home',
          config: AsyncData(maintenance),
          session: AsyncData(_me),
        ),
        '/maintenance',
      );
      expect(_redirect('/home', session: AsyncData(_me), build: 4), '/update');
      expect(
        _redirect('/home', session: AsyncData(_me), build: 4, isIOS: true),
        isNull,
      );
      // Unknown build number (0) never forces an update.
      expect(_redirect('/home', session: AsyncData(_me), build: 0), isNull);
    });
  });

  test('push payloads map to routes', () {
    expect(routeForLink({'type': 'live', 'roomId': 'abc'}), '/live/abc');
    expect(routeForLink({'type': 'chat', 'conversationId': 'c1'}), '/chat/c1');
    expect(
      routeForLink({'type': 'chat', 'conversationId': 'c1', 'senderId': 'u9'}),
      '/chat/c1?peer=u9',
    );
    expect(routeForLink({'type': 'follow', 'userId': 'u1'}), '/user/u1');
    expect(routeForLink({'type': 'withdrawal'}), '/wallet');
    expect(routeForLink({'type': 'system'}), '/notifications');
    expect(routeForLink({'url': 'https://evil.example'}), isNull);
    expect(routeForLink({}), isNull);
  });

  test('bigboss:// links open only known screens', () {
    expect(routeForLink({'url': 'bigboss://vip'}), '/vip');
    expect(routeForLink({'url': 'bigboss://post/p1'}), '/post/p1');
    expect(routeForLink({'link': 'bigboss://user/u1'}), '/user/u1');
    expect(
      routeForLink({'url': 'bigboss://wallet?tab=beans'}),
      '/wallet?tab=beans',
    );
    // Screens that need in-memory arguments, and auth screens, are not linkable.
    expect(routeForLink({'url': 'bigboss://games/play'}), '/games');
    expect(routeForLink({'url': 'bigboss://otp'}), isNull);
    expect(routeForLink({'url': 'bigboss://splash'}), isNull);
    expect(routeForLink({'url': 'bigboss://'}), isNull);
  });

  test('providers retry only network failures, briefly', () {
    const offline = ApiException(0, 'network', 'offline');
    expect(providerRetry(0, offline), const Duration(milliseconds: 500));
    expect(providerRetry(2, offline), const Duration(seconds: 2));
    expect(providerRetry(3, offline), isNull);
    expect(
      providerRetry(0, const ApiException(403, 'account_banned', 'x')),
      isNull,
    );
    expect(providerRetry(0, StateError('bug')), isNull);
  });
}
