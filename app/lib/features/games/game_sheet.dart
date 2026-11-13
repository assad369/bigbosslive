import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'game_host_bridge.dart';

enum _Phase { launching, loading, ready, failed }

/// An AsadSoft game in a bottom sheet at 75% of the screen (the height their games are laid
/// out for), opened from the Games screen and over a live room alike; a live keeps playing
/// above it. The backend opens the provider session; money then moves through AsadSoft's
/// calls to our wallet, never through the page.
///
/// Every way out (Android back, the close handle) goes through the game's own exit
/// ([GameExitController]), so a player with a stake on the live round is asked first. The
/// sheet can't be dragged or tapped away for the same reason.
class GameSheet extends ConsumerStatefulWidget {
  const GameSheet({super.key, required this.game, required this.inLive});
  final GameInfo game;
  final bool inLive;

  static Future<void> show(
    BuildContext context,
    GameInfo game, {
    required bool inLive,
  }) {
    final lock = game.lock;
    if (lock != null) {
      showMessage(context, lock.message);
      return Future.value();
    }
    return showModalBottomSheet<void>(
      context: context,
      // Above the shell, so the wallet (a root route) can open on top of it.
      useRootNavigator: true,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: BBColors.espresso,
      clipBehavior: Clip.antiAlias,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => FractionallySizedBox(
        heightFactor: 0.75,
        child: GameSheet(game: game, inLive: inLive),
      ),
    );
  }

  @override
  ConsumerState<GameSheet> createState() => _GameSheetState();
}

class _GameSheetState extends ConsumerState<GameSheet> {
  WebViewController? _web;
  _Phase _phase = _Phase.launching;
  String? _error;
  bool _canRetry = true;
  String? _host;
  late GameExitController _exit;
  Timer? _refresh;
  Completer<void>? _sessionEnded;
  bool _popped = false;

  @override
  void initState() {
    super.initState();
    _exit = _newExit();
    unawaited(_launch());
  }

  GameExitController _newExit() =>
      GameExitController(send: _run, hardClose: _hardClose, close: _pop);

  @override
  void dispose() {
    _exit.dispose();
    _refresh?.cancel();
    // Torn down some other way (a deep link replaced the stack): end the session anyway.
    // The page's own `pagehide` and the provider's abandon timer are the backstops.
    if (!_exit.done) _run(GameHostScripts.forceEnd);
    super.dispose();
  }

  /// Release builds open only https: the URL carries a session token the page reads.
  static bool _allowed(Uri uri) =>
      uri.scheme == 'https' || (!kReleaseMode && uri.scheme == 'http');

  Future<void> _launch() async {
    if (_phase != _Phase.launching) {
      setState(() {
        _phase = _Phase.launching;
        _error = null;
        _web = null;
      });
    }
    _exit.dispose();
    _exit = _newExit();
    try {
      final launch = await ref
          .read(economyRepo)
          .launchGame(widget.game.gameId, inLive: widget.inLive);
      final uri = Uri.tryParse(launch.gameUrl);
      if (uri == null || !_allowed(uri)) {
        throw const FormatException('This game is unavailable right now.');
      }
      _host = uri.host;
      final web = await _createWebView();
      if (!mounted) return;
      setState(() {
        _web = web;
        _phase = _Phase.loading;
      });
      await web.loadRequest(uri);
    } on ApiException catch (e) {
      _fail(
        e.isNetwork
            ? 'No connection. Check your internet and try again.'
            : e.message,
        retry: e.code != 'game_locked',
      );
    } catch (_) {
      _fail('The game didn\'t load');
    }
  }

  Future<WebViewController> _createWebView() async {
    var params = const PlatformWebViewControllerCreationParams();
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    }
    final web = WebViewController.fromPlatformCreationParams(params);
    await web.setJavaScriptMode(JavaScriptMode.unrestricted);
    await web.setBackgroundColor(BBColors.espresso);
    final platform = web.platform;
    if (platform is AndroidWebViewController) {
      // Game sounds start with the first round, not only after a tap.
      await platform.setMediaPlaybackRequiresUserGesture(false);
    }
    await web.addJavaScriptChannel(
      GameHostScripts.channel,
      onMessageReceived: (m) => _onRaw(m.message),
    );
    await web.setNavigationDelegate(
      NavigationDelegate(
        onPageStarted: (_) => _inject(web),
        onPageFinished: (url) {
          _inject(web);
          if (mounted && _phase == _Phase.loading && url != 'about:blank') {
            setState(() => _phase = _Phase.ready);
          }
        },
        onWebResourceError: (e) {
          // Only the page itself counts; a missing image inside the game doesn't.
          if ((e.isForMainFrame ?? true) && !_exit.done) {
            _fail('The game didn\'t load');
          }
        },
        // The game never navigates away; keep it on its own host over an allowed scheme.
        onNavigationRequest: (r) {
          if (r.url == 'about:blank') return NavigationDecision.navigate;
          final next = Uri.tryParse(r.url);
          return next != null && next.host == _host && _allowed(next)
              ? NavigationDecision.navigate
              : NavigationDecision.prevent;
        },
      ),
    );
    return web;
  }

  void _inject(WebViewController web) => unawaited(
    web.runJavaScript(GameHostScripts.install).catchError((Object _) {}),
  );

  void _run(String script) {
    final web = _web;
    if (web == null) return;
    unawaited(web.runJavaScript(script).catchError((Object _) {}));
  }

  void _onRaw(String raw) {
    final e = GameEvent.parse(raw);
    if (e == null || !mounted) return;
    if (e.type == 'SESSION_ENDED') {
      // Whatever the reason, a hard close waiting on the game's confirmation can go on.
      final ended = _sessionEnded;
      if (ended != null && !ended.isCompleted) ended.complete();
    }
    switch (actionFor(e)) {
      case GameEventAction.close:
        _refreshBalance();
        _exit.onExitGame();
      case GameEventAction.exitAck:
        _exit.onAck(e.str('state'));
      case GameEventAction.fail:
        if (!_exit.done) {
          _fail(e.str('error') ?? 'This game session has ended.');
        }
      case GameEventAction.recharge:
        unawaited(context.push('/wallet'));
      case GameEventAction.refreshBalance:
        _refreshBalance();
      case GameEventAction.ignore:
        break;
    }
  }

  /// `wallet:updated` already carries each new balance; this settles the rest of `/me`.
  void _refreshBalance() {
    _refresh?.cancel();
    _refresh = Timer(const Duration(milliseconds: 800), () {
      if (mounted) unawaited(ref.read(sessionProvider.notifier).refresh());
    });
  }

  void _fail(String message, {bool retry = true}) {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.failed;
      _error = message;
      _canRetry = retry;
    });
    // Leave nothing running behind the error.
    _run(GameHostScripts.forceEnd);
  }

  /// FORCE_END, wait briefly for the game to confirm, blank the page, close.
  Future<void> _hardClose() async {
    if (_web != null && _phase != _Phase.failed) {
      final ended = _sessionEnded = Completer<void>();
      _run(GameHostScripts.forceEnd);
      await ended.future.timeout(
        const Duration(milliseconds: 1200),
        onTimeout: () {},
      );
      await _web
          ?.loadRequest(Uri.parse('about:blank'))
          .catchError((Object _) {});
    }
    _refreshBalance();
    _pop();
  }

  void _pop() {
    if (_popped || !mounted) return;
    _popped = true;
    Navigator.of(context).pop();
  }

  /// Back or the close handle: the game decides, unless there's no live game to ask.
  void _requestClose() {
    if (_phase == _Phase.ready || _phase == _Phase.loading) {
      _exit.requestExit();
    } else {
      _exit.forceClose();
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) _requestClose();
    },
    child: AnimatedPadding(
      // The game's own number fields (the game wallet dialog) bring up the keyboard.
      duration: const Duration(milliseconds: 150),
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        children: [
          _Header(title: widget.game.name, onClose: _requestClose),
          Expanded(child: _body()),
        ],
      ),
    ),
  );

  Widget _body() {
    if (_phase == _Phase.failed) {
      return _GameError(
        message: _error ?? 'The game didn\'t load',
        onRetry: _canRetry ? _launch : null,
      );
    }
    final web = _web;
    return Stack(
      children: [
        if (web != null) WebViewWidget(controller: web),
        if (_phase != _Phase.ready)
          const ColoredBox(
            color: BBColors.espresso,
            child: Center(
              child: CircularProgressIndicator(color: BBColors.goldLight),
            ),
          ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.title, required this.onClose});
  final String title;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 44,
    child: Row(
      children: [
        const SizedBox(width: 16),
        Expanded(
          child: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: BBColors.ivory,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        IconButton(
          tooltip: 'Close',
          onPressed: onClose,
          icon: const Icon(Icons.close_rounded, color: BBColors.ivory),
        ),
      ],
    ),
  );
}

class _GameError extends StatelessWidget {
  const _GameError({required this.message, this.onRetry});
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.sports_esports_outlined,
            color: BBColors.goldLight,
            size: 48,
          ),
          const SizedBox(height: 12),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(color: BBColors.ivory, fontSize: 16),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
            GoldButton(label: 'Try again', onPressed: onRetry),
          ],
        ],
      ),
    ),
  );
}
