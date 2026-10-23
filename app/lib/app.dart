import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/providers.dart';
import 'core/push/push_service.dart';
import 'core/router/app_router.dart';
import 'core/theme/bb_theme.dart';

final pushProvider = Provider<PushService>(
  (ref) => PushService(ref.watch(accountRepo)),
);

class BigBossApp extends ConsumerStatefulWidget {
  const BigBossApp({super.key, this.enablePush = true});
  final bool enablePush;

  @override
  ConsumerState<BigBossApp> createState() => _BigBossAppState();
}

class _BigBossAppState extends ConsumerState<BigBossApp> {
  StreamSubscription<Map<String, dynamic>>? _taps;

  @override
  void initState() {
    super.initState();
    // Keep the realtime connection alive for the whole signed-in session.
    ref.read(socketProvider);
    if (widget.enablePush) {
      _taps = ref.read(pushProvider).taps.listen((data) {
        final route = routeForLink(data);
        if (route != null) unawaited(ref.read(routerProvider).push(route));
      });
    }
  }

  @override
  void dispose() {
    _taps?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.enablePush) {
      ref.listen(sessionProvider, (prev, next) {
        final push = ref.read(pushProvider);
        if (prev?.value == null && next.value != null) unawaited(push.start());
        if (prev?.value != null && next.hasValue && next.value == null) {
          unawaited(push.stop());
        }
      });
    }
    return MaterialApp.router(
      title: 'BigBoss Live',
      debugShowCheckedModeBanner: false,
      theme: BBTheme.light(),
      themeMode: ThemeMode.light,
      routerConfig: ref.watch(routerProvider),
    );
  }
}
