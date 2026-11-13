import 'dart:async';
import 'dart:convert';

/// The host side of AsadSoft's game bridge (`shared/wallet-bridge.js`), for `webview_flutter`.
///
/// The game talks to its host only through `window.parent.postMessage` and
/// `window.flutter_inappwebview.callHandler('gameEvent', …)`. In a top-level WebView
/// `parent === window`, so we listen to the page's own `message` events and forward the
/// game's (`source: 'asadsoft-game'`) to a JavaScript channel. A no-op `flutter_inappwebview`
/// stub tells the bridge a host is present, so it never runs its own exit fallback (history
/// back, a "session ended" page) under us; it forwards nothing, so no event arrives twice.
/// Host → game messages are `window.postMessage(obj, '*')`, which the bridge accepts from a
/// top-level page.
abstract final class GameHostScripts {
  /// The JavaScript channel the listener posts to.
  static const channel = 'BBGameHost';

  /// Idempotent: injected on page start and again on page finish.
  static const install =
      '''
(function () {
  if (window.__bbGameHost) return;
  window.__bbGameHost = true;
  if (!window.flutter_inappwebview) {
    window.flutter_inappwebview = { callHandler: function () { return Promise.resolve(); } };
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object' || d.source !== 'asadsoft-game') return;
    try { $channel.postMessage(JSON.stringify(d)); } catch (_) {}
  });
})();
''';

  /// Delivers [message] (an object, as the bridge requires) to the game.
  static String post(Map<String, Object?> message) =>
      'window.postMessage(${jsonEncode(message)}, "*");';

  static final requestExit = post({'type': 'REQUEST_EXIT'});
  static final forceEnd = post({'type': 'FORCE_END'});
  static final requestBalance = post({'type': 'REQUEST_BALANCE'});
}

/// One message from the game.
class GameEvent {
  const GameEvent(this.type, this.data);
  final String type;
  final Map<String, dynamic> data;

  String? str(String key) => switch (data[key]) {
    final String v => v,
    _ => null,
  };

  /// A message our listener forwarded, or null for anything else (never trust its shape).
  static GameEvent? parse(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      if (decoded['source'] != 'asadsoft-game') return null;
      final type = decoded['type'];
      if (type is! String || type.isEmpty) return null;
      return GameEvent(type, decoded);
    } catch (_) {
      return null;
    }
  }
}

/// What the host does with an event.
enum GameEventAction {
  /// The player left (EXIT_GAME): close the sheet.
  close,

  /// The session is gone (SESSION_INVALID, BOOT_ERROR, a failed end): offer a relaunch.
  fail,

  /// Open the wallet to buy diamonds.
  recharge,

  /// Diamonds moved: refresh the balance.
  refreshBalance,

  /// The answer to our REQUEST_EXIT.
  exitAck,
  ignore,
}

/// The host's reaction to [e]. Pure.
GameEventAction actionFor(GameEvent e) => switch (e.type) {
  'EXIT_GAME' => GameEventAction.close,
  'SESSION_INVALID' || 'BOOT_ERROR' => GameEventAction.fail,
  // Our own FORCE_END is answered with reason 'host' and the player's own exit with
  // 'player'. Only an end that failed for some other reason leaves the session unusable.
  'SESSION_ENDED' => switch (e.str('reason')) {
    'host' => GameEventAction.ignore,
    'player' => GameEventAction.refreshBalance,
    _ =>
      e.str('error') != null
          ? GameEventAction.fail
          : GameEventAction.refreshBalance,
  },
  'INSUFFICIENT_BALANCE' || 'OPEN_RECHARGE' => GameEventAction.recharge,
  // Each stake already pushes `wallet:updated`; these settle a round.
  'ROUND_COMPLETE' ||
  'CASHBACK' ||
  'WALLET_TRANSFER' => GameEventAction.refreshBalance,
  'EXIT_REQUEST_ACK' => GameEventAction.exitAck,
  _ => GameEventAction.ignore,
};

typedef TimerFactory = Timer Function(Duration, void Function());

/// The exit handshake (the provider's FLUTTER_INTEGRATION.md §9). Every way out of the
/// sheet goes through the game, which alone knows whether the player has a stake on the
/// live round and needs a "Leave the table?" confirmation:
///
/// `REQUEST_EXIT` → `EXIT_REQUEST_ACK {state}`:
/// - `leaving` / `busy`: `EXIT_GAME` follows; a failsafe hard-closes if it doesn't.
/// - `confirming`: the game's Stay/Leave dialog is up; wait.
/// - `dismissed`: a second back closed that dialog; stay.
/// - no ack in time (page still loading, boot error, an old build): hard close.
class GameExitController {
  GameExitController({
    required this.send,
    required this.hardClose,
    required this.close,
    this.ackTimeout = const Duration(milliseconds: 800),
    this.failsafe = const Duration(seconds: 4),
    TimerFactory? timer,
  }) : _timer = timer ?? Timer.new;

  /// Posts a script to the game.
  final void Function(String script) send;

  /// FORCE_END, then blank the page, then close. Called at most once.
  final Future<void> Function() hardClose;

  /// Closes the sheet after the game ended its own session. Called at most once.
  final void Function() close;
  final Duration ackTimeout;
  final Duration failsafe;
  final TimerFactory _timer;

  Timer? _pending;
  bool _awaitingAck = false;
  bool _done = false;

  bool get done => _done;

  /// The player wants out (back, the close handle).
  void requestExit() {
    if (_done || _awaitingAck) return;
    _awaitingAck = true;
    send(GameHostScripts.requestExit);
    _pending?.cancel();
    _pending = _timer(ackTimeout, () {
      _awaitingAck = false;
      _forceClose();
    });
  }

  void onAck(String? state) {
    if (_done) return;
    _awaitingAck = false;
    _pending?.cancel();
    _pending = null;
    if (state == 'leaving' || state == 'busy') {
      _pending = _timer(failsafe, _forceClose);
    }
  }

  /// EXIT_GAME: the game ended its session and wants to go.
  void onExitGame() {
    if (_done) return;
    _done = true;
    _pending?.cancel();
    close();
  }

  /// Close now, without asking the game (the page never answered, or failed to load).
  void forceClose() => _forceClose();

  void _forceClose() {
    if (_done) return;
    _done = true;
    _pending?.cancel();
    unawaited(hardClose());
  }

  void dispose() {
    _pending?.cancel();
    _pending = null;
  }
}
