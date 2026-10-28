import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/providers.dart';
import 'core/router/app_router.dart';
import 'core/theme/bb_theme.dart';
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

  @override
  void initState() {
    super.initState();
    // Keep the realtime connection alive for the whole signed-in session.
    ref.read(socketProvider);
    if (widget.enablePlatformServices) {
      _taps = ref.read(pushProvider).taps.listen((data) {
        final route = routeForLink(data);
        if (route != null) unawaited(ref.read(routerProvider).push(route));
      });
      // From launch: StoreKit redelivers unfinished purchases as soon as anyone listens.
      ref.read(iapProvider).attach();
    }
    // Maintenance mode and force-update are re-checked whenever the app comes back.
    _lifecycle = AppLifecycleListener(
      onResume: () => ref.invalidate(appConfigProvider),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _taps?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
