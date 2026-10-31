import 'dart:async';
import 'dart:io';

import 'package:bigboss_live/core/config/env.dart';
import 'package:bigboss_live/core/deep_links/deep_link.dart';
import 'package:bigboss_live/core/deep_links/deep_link_service.dart';
import 'package:bigboss_live/core/deep_links/pending_route.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _room = '65f0c0ffee0123456789abcd';

Uri _link(String path) => Uri.parse('https://${Env.linkHost}$path');

void main() {
  group('parseDeepLink', () {
    test('reads each kind', () {
      expect(parseDeepLink(_link('/live/$_room')), const LiveLink(_room));
      expect(parseDeepLink(_link('/u/200')), const ProfileLink('200'));
      expect(parseDeepLink(_link('/post/$_room')), const PostLink(_room));
    });

    test('tolerates a trailing slash, query and fragment', () {
      expect(
        parseDeepLink(_link('/live/$_room/?utm=x#top')),
        const LiveLink(_room),
      );
    });

    test('rejects other hosts, schemes, shapes and ids', () {
      expect(parseDeepLink(Uri.parse('https://evil.test/live/$_room')), isNull);
      expect(
        parseDeepLink(Uri.parse('http://${Env.linkHost}/live/$_room')),
        isNull,
      );
      expect(parseDeepLink(_link('/live/not-an-id')), isNull);
      expect(parseDeepLink(_link('/u/12')), isNull);
      expect(parseDeepLink(_link('/live/$_room/extra')), isNull);
      expect(parseDeepLink(_link('/games/$_room')), isNull);
    });

    test('share and app routes', () {
      const live = LiveLink(_room);
      expect(live.shareUri.toString(), 'https://${Env.linkHost}/live/$_room');
      expect(live.appRoute, '/live/$_room');
      expect(const ProfileLink('200').appRoute, '/u/200');
    });

    test('prefixes match DEEP_LINK_ROUTES in packages/shared', () {
      final source = File('../packages/shared/src/constants.ts')
          .readAsStringSync();
      final block = source.substring(
        source.indexOf('export const DEEP_LINK_ROUTES'),
        source.indexOf('] as const;', source.indexOf('DEEP_LINK_ROUTES')),
      );
      final prefixes = RegExp(r"prefix: '([^']+)'")
          .allMatches(block)
          .map((m) => m[1])
          .toList();
      expect(prefixes, unorderedEquals(deepLinkPrefixes));
    });
  });

  group('decidePendingRoute', () {
    PendingRouteAction decide(
      String route,
      String at, {
      bool signedIn = true,
    }) => decidePendingRoute(signedIn: signedIn, route: route, currentPath: at);

    test('waits for sign-in and the boot screens', () {
      expect(
        decide('/live/a', '/home', signedIn: false),
        PendingRouteAction.wait,
      );
      expect(decide('/live/a', '/splash'), PendingRouteAction.wait);
      expect(decide('/live/a', '/login'), PendingRouteAction.wait);
    });

    test('skips, pushes or replaces a live', () {
      expect(decide('/live/a', '/live/a'), PendingRouteAction.skip);
      expect(decide('/live/a', '/home'), PendingRouteAction.push);
      expect(decide('/u/200', '/live/a'), PendingRouteAction.push);
      expect(decide('/live/b', '/live/a'), PendingRouteAction.replaceLive);
    });
  });

  group('DeepLinkService', () {
    test('queues links, drops repeats and flags unknown ones', () async {
      final links = StreamController<Uri>();
      var now = DateTime(2026);
      final container = ProviderContainer(
        overrides: [
          deepLinkServiceProvider.overrideWith(
            (ref) =>
                DeepLinkService(ref, links: links.stream, clock: () => now),
          ),
        ],
      );
      addTearDown(container.dispose);
      container.read(deepLinkServiceProvider).start();

      links.add(_link('/live/$_room'));
      await pumpEventQueue();
      expect(container.read(pendingRouteProvider), '/live/$_room');

      container.read(pendingRouteProvider.notifier).take();
      links.add(_link('/live/$_room'));
      await pumpEventQueue();
      expect(container.read(pendingRouteProvider), isNull);

      now = now.add(DeepLinkService.dedupeWindow);
      links.add(_link('/live/$_room'));
      await pumpEventQueue();
      expect(container.read(pendingRouteProvider), '/live/$_room');

      links.add(_link('/clips/$_room'));
      await pumpEventQueue();
      expect(container.read(unsupportedLinkProvider), isNotNull);

      links.add(Uri.parse('bigboss://wallet'));
      await pumpEventQueue();
      expect(container.read(pendingRouteProvider), '/wallet');
      await links.close();
    });
  });
}
