import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/config/env.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final _gamesProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).games(),
);

class GamesScreen extends ConsumerWidget {
  const GamesScreen({super.key});

  static const _art = {
    'golden_wheel': ('👑', BBColors.goldGradient),
    'fortune_ferris': ('🎡', BBColors.bronzeGradient),
    'teen_patti': (
      '🂡',
      LinearGradient(colors: [BBColors.feltGreen, BBColors.feltGreenDeep]),
    ),
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final games = ref.watch(_gamesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Games')),
      body: AsyncView(
        value: games,
        onRetry: () => ref.invalidate(_gamesProvider),
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.casino_outlined,
                title: 'Games are resting',
                message: 'Check back soon.',
              )
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  for (final g in items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(22),
                        onTap: () => context.push('/games/play', extra: g),
                        child: Container(
                          height: 120,
                          padding: const EdgeInsets.all(20),
                          decoration: BoxDecoration(
                            gradient: _art[g.key]?.$2 ?? BBColors.goldGradient,
                            borderRadius: BorderRadius.circular(22),
                          ),
                          child: Row(
                            children: [
                              Text(
                                _art[g.key]?.$1 ?? '🎲',
                                style: const TextStyle(fontSize: 54),
                              ),
                              const SizedBox(width: 18),
                              Expanded(
                                child: Text(
                                  g.name,
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineSmall
                                      ?.copyWith(color: BBColors.ivory),
                                ),
                              ),
                              const Icon(
                                Icons.play_circle_fill_rounded,
                                color: BBColors.ivory,
                                size: 40,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  const Text(
                    'Games use diamonds, which have no cash value. Play responsibly — 18+ only.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
                  ),
                ],
              ),
      ),
    );
  }
}

/// Hosts a WebView game. The Firebase ID token travels in the URL fragment (never sent to a
/// server); refreshes are pushed through `window.bbSetToken` when the game asks.
/// The live room's Games button: the same games in a sheet. A game opens on top of the
/// live, which keeps running underneath.
class LiveGamesSheet extends ConsumerWidget {
  const LiveGamesSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (_) => const LiveGamesSheet(),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final games = ref.watch(_gamesProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Games',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            AsyncView(
              value: games,
              onRetry: () => ref.invalidate(_gamesProvider),
              data: (items) => items.isEmpty
                  ? const EmptyState(
                      icon: Icons.casino_outlined,
                      title: 'Games are resting',
                      message: 'Check back soon.',
                    )
                  : GridView.extent(
                      shrinkWrap: true,
                      maxCrossAxisExtent: 92,
                      mainAxisSpacing: 8,
                      crossAxisSpacing: 8,
                      childAspectRatio: 92 / 100,
                      children: [
                        for (final g in items)
                          InkWell(
                            borderRadius: BorderRadius.circular(16),
                            onTap: () {
                              final router = GoRouter.of(context);
                              Navigator.pop(context);
                              unawaited(router.push('/games/play', extra: g));
                            },
                            child: Column(
                              children: [
                                Container(
                                  width: 60,
                                  height: 60,
                                  alignment: Alignment.center,
                                  decoration: BoxDecoration(
                                    gradient:
                                        GamesScreen._art[g.key]?.$2 ??
                                        BBColors.goldGradient,
                                    borderRadius: BorderRadius.circular(16),
                                  ),
                                  child: Text(
                                    GamesScreen._art[g.key]?.$1 ?? '🎲',
                                    style: const TextStyle(fontSize: 32),
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  g.name,
                                  maxLines: 2,
                                  textAlign: TextAlign.center,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 12),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class GameWebViewScreen extends ConsumerStatefulWidget {
  const GameWebViewScreen({super.key, required this.game});
  final GameInfo game;

  @override
  ConsumerState<GameWebViewScreen> createState() => _GameWebViewScreenState();
}

class _GameWebViewScreenState extends ConsumerState<GameWebViewScreen> {
  WebViewController? _controller;
  bool _loading = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  /// The ID token rides in the fragment, but the page's scripts read it, so a page served
  /// over plain http could be swapped by anyone on the network. Release builds only load
  /// https (debug builds allow a local dev server).
  static bool _allowed(Uri uri) =>
      uri.scheme == 'https' || (!kReleaseMode && uri.scheme == 'http');

  Future<void> _init() async {
    if (_error != null) {
      // A retry; the first run comes from initState, where setState isn't allowed.
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final base = Uri.parse(widget.game.url);
      if (!_allowed(base)) {
        throw const FormatException('This game is unavailable right now.');
      }
      final token = await FirebaseAuth.instance.currentUser?.getIdToken();
      final url = base.replace(
        fragment:
            'token=${Uri.encodeComponent(token ?? '')}&api=${Uri.encodeComponent(Env.apiUrl)}',
      );
      final c = WebViewController();
      // Set before loading: the page may post a message as soon as it starts.
      _controller = c;
      await c.setJavaScriptMode(JavaScriptMode.unrestricted);
      await c.setBackgroundColor(BBColors.espresso);
      await c.addJavaScriptChannel(
        'BigBossBridge',
        onMessageReceived: (m) => _onMessage(m.message),
      );
      await c.setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (_) =>
              mounted ? setState(() => _loading = false) : null,
          onWebResourceError: (e) {
            // Only a failed page counts; a missing image inside the game doesn't.
            if (e.isForMainFrame ?? true) {
              if (mounted) setState(() => _error = e.description);
            }
          },
          // Keep the WebView on the game's own origin, over an allowed scheme.
          onNavigationRequest: (r) {
            final next = Uri.tryParse(r.url);
            return next != null && next.host == base.host && _allowed(next)
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
        ),
      );
      await c.loadRequest(url);
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _onMessage(String raw) async {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'token_expired':
        try {
          final token = await FirebaseAuth.instance.currentUser?.getIdToken(
            true,
          );
          await _controller?.runJavaScript(
            'window.bbSetToken && window.bbSetToken(${jsonEncode(token ?? '')})',
          );
        } catch (_) {
          /* the game shows its own sign-in error */
        }
      case 'close':
        if (mounted) context.pop();
      case 'recharge':
        if (mounted) unawaited(context.push('/wallet'));
      case 'balance':
        // The page's word is only a hint that the balance moved; the server is the source.
        if (mounted) unawaited(ref.read(sessionProvider.notifier).refresh());
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: BBColors.espresso,
    body: SafeArea(
      child: _error != null
          ? Column(
              children: [
                Align(
                  alignment: Alignment.topLeft,
                  child: IconButton(
                    tooltip: 'Close',
                    onPressed: () => context.pop(),
                    icon: const Icon(Icons.close, color: BBColors.ivory),
                  ),
                ),
                Expanded(
                  child: Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.wifi_off_rounded,
                            color: BBColors.goldLight,
                            size: 48,
                          ),
                          const SizedBox(height: 12),
                          const Text(
                            'The game didn\'t load',
                            style: TextStyle(
                              color: BBColors.ivory,
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 16),
                          GoldButton(label: 'Try again', onPressed: _init),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            )
          : Stack(
              children: [
                if (_controller != null)
                  WebViewWidget(controller: _controller!),
                if (_loading) const Center(child: CircularProgressIndicator()),
              ],
            ),
    ),
  );
}
