import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/deep_links/deep_link_service.dart';
import 'core/deep_links/pending_route.dart';
import 'core/providers.dart';
import 'core/router/app_router.dart';
import 'core/theme/bb_theme.dart';
import 'core/widgets/widgets.dart';
import 'features/live/active_live.dart';
import 'features/live/mini_live_player.dart';

class BigBossApp extends ConsumerStatefulWidget {
  const BigBossApp({super.key, this.enablePlatformServices = true});

  /// Push notifications and in-app purchases; off in widget tests.
  final bool enablePlatformServices;

  @override
  ConsumerState<BigBossApp> createState() => _BigBossAppState();
}

class _BigBossAppState extends ConsumerState<BigBossApp> {
  StreamSubscription<Map<String, dynamic>>? _taps;
  late final AppLifecycleListener _lifecycle;
  late final GoRouter _router;
  bool _dispatchScheduled = false;
  bool _confirming = false;

  @override
  void initState() {
    super.initState();
    // Keep the realtime connection alive for the whole signed-in session.
    ref.read(socketProvider);
    // Each navigation (the redirect leaving splash or login, say) may free a waiting link.
    _router = ref.read(routerProvider)
      ..routerDelegate.addListener(_dispatchPending);
    if (widget.enablePlatformServices) {
      // Before the first frame, so the link that launched the app isn't missed.
      ref.read(deepLinkServiceProvider).start();
      // Through the pending route too, so a tap during splash or sign-in still lands.
      _taps = ref.read(pushProvider).taps.listen((data) {
        final route = routeForLink(data);
        if (route != null) ref.read(pendingRouteProvider.notifier).set(route);
      });
      // From launch: StoreKit redelivers unfinished purchases as soon as anyone listens.
      ref.read(iapProvider).attach();
    }
    // Maintenance mode and force-update are re-checked whenever the app comes back.
    _lifecycle = AppLifecycleListener(
      onResume: () => ref.invalidate(appConfigProvider),
    );
  }

  /// Opens a share link or push target once the app can: signed in, past the boot screens.
  /// Runs after the frame, so the redirect has already applied.
  void _dispatchPending() {
    if (_dispatchScheduled || _confirming) return;
    _dispatchScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _dispatchScheduled = false;
      if (!mounted) return;
      final route = ref.read(pendingRouteProvider);
      if (route == null) return;
      final action = decidePendingRoute(
        signedIn: ref.read(sessionUidProvider) != null,
        route: route,
        currentPath: _router.routerDelegate.currentConfiguration.uri.path,
      );
      switch (action) {
        case PendingRouteAction.wait:
          return;
        case PendingRouteAction.skip:
          ref.read(pendingRouteProvider.notifier).take();
        case PendingRouteAction.push:
          ref.read(pendingRouteProvider.notifier).take();
          unawaited(_router.push(route));
        case PendingRouteAction.replaceLive:
          ref.read(pendingRouteProvider.notifier).take();
          final context = _router.routerDelegate.navigatorKey.currentContext;
          if (context == null) return;
          _confirming = true;
          final ok = await showDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('Leave this live?'),
              content: const Text('The link opens another live.'),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Stay'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Open it'),
                ),
              ],
            ),
          );
          _confirming = false;
          if (ok == true && mounted) unawaited(_router.pushReplacement(route));
      }
    });
  }

  @override
  void dispose() {
    _router.routerDelegate.removeListener(_dispatchPending);
    _lifecycle.dispose();
    _taps?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(pendingRouteProvider, (_, _) => _dispatchPending());
    ref.listen(sessionUidProvider, (_, _) => _dispatchPending());
    ref.listen(unsupportedLinkProvider, (_, message) {
      if (message == null) return;
      final context = _router.routerDelegate.navigatorKey.currentContext;
      if (context != null) showMessage(context, message);
      ref.read(unsupportedLinkProvider.notifier).set(null);
    });
    if (widget.enablePlatformServices) {
      ref.listen(sessionUidProvider, (prev, uid) {
        final push = ref.read(pushProvider);
        final iap = ref.read(iapProvider);
        if (uid != null && prev != uid) {
          unawaited(push.start());
          unawaited(iap.start());
        }
        if (uid == null && prev != null) {
          unawaited(push.stop());
          iap.stop();
        }
      });
    }
    return MaterialApp.router(
      title: 'BigBoss Live',
      debugShowCheckedModeBanner: false,
      theme: BBTheme.light(),
      themeMode: ThemeMode.light,
      routerConfig: ref.watch(routerProvider),
      scaffoldMessengerKey: liveMessengerKey,
      // Above the Navigator so a minimized live floats over every route.
      builder: (context, child) => LiveOverlayHost(child: child!),
    );
  }
}
