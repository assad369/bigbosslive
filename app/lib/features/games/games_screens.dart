import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
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
      LinearGradient(colors: [Color(0xFF3C6B4A), Color(0xFF18301F)]),
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
class GameWebViewScreen extends ConsumerStatefulWidget {
  const GameWebViewScreen({super.key, required this.game});
  final GameInfo game;

  @override
  ConsumerState<GameWebViewScreen> createState() => _GameWebViewScreenState();
}

class _GameWebViewScreenState extends ConsumerState<GameWebViewScreen> {
  WebViewController? _controller;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  Future<void> _init() async {
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    final base = Uri.parse(widget.game.url);
    final url = base.replace(
      fragment:
          'token=${Uri.encodeComponent(token ?? '')}&api=${Uri.encodeComponent(Env.apiUrl)}',
    );
    final c = WebViewController();
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
        // Keep the WebView on the game's own origin.
        onNavigationRequest: (r) => Uri.parse(r.url).host == base.host
            ? NavigationDecision.navigate
            : NavigationDecision.prevent,
      ),
    );
    await c.loadRequest(url);
    if (mounted) setState(() => _controller = c);
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
        final token = await FirebaseAuth.instance.currentUser?.getIdToken(true);
        await _controller?.runJavaScript(
          'window.bbSetToken && window.bbSetToken(${jsonEncode(token ?? '')})',
        );
      case 'close':
        if (mounted) context.pop();
      case 'recharge':
        if (mounted) unawaited(context.push('/wallet'));
      case 'balance':
        final diamonds = msg['diamonds'];
        final me = ref.read(sessionProvider).value;
        if (diamonds is num && me != null) {
          ref
              .read(sessionProvider.notifier)
              .replace(me.withDiamonds(diamonds.toInt()));
        }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: BBColors.espresso,
    body: SafeArea(
      child: Stack(
        children: [
          if (_controller != null) WebViewWidget(controller: _controller!),
          if (_loading) const Center(child: CircularProgressIndicator()),
        ],
      ),
    ),
  );
}
