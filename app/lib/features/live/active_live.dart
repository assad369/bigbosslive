import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/platform/pip_service.dart';
import '../../core/providers.dart';
import '../../core/utils/json.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

typedef LiveControllerFactory = LiveRoomController Function({
  required String roomId,
  LiveSession? hostSession,
});

/// Overridable in tests, where a real LiveKit [Room] can't connect.
final liveControllerFactoryProvider = Provider<LiveControllerFactory>(
  (ref) =>
      ({required roomId, hostSession}) => LiveRoomController(
        roomId: roomId,
        myUid: ref.read(meProvider).id,
        repo: ref.read(liveRepo),
        hostSession: hostSession,
      ),
);

/// Shown when a session ends while nobody is looking at the full screen (mini-player).
final liveMessengerKey = GlobalKey<ScaffoldMessengerState>();

/// The one live session the user is in, full screen or minimized.
@immutable
class ActiveLive {
  const ActiveLive(this.controller, {this.minimized = false});
  final LiveRoomController controller;
  final bool minimized;

  String get roomId => controller.roomId;
}

/// Terminal states: nothing left to watch, so minimizing closes instead.
bool _isOver(LiveStatus s) =>
    s == LiveStatus.ended || s == LiveStatus.kicked || s == LiveStatus.failed;

final activeLiveProvider = NotifierProvider<ActiveLiveNotifier, ActiveLive?>(
  ActiveLiveNotifier.new,
);

/// Owns the live session's lifetime so it can outlive [LiveRoomScreen]: pressing back
/// minimizes it into the floating player instead of disconnecting.
///
/// Screens call [attach]/[detach] from `initState`/`dispose`, where Riverpod forbids
/// provider writes. So [current] is updated synchronously and [state] mirrors it one
/// microtask later.
class ActiveLiveNotifier extends Notifier<ActiveLive?> {
  ActiveLive? _current;
  bool _publishScheduled = false;

  /// Where the user last dropped the mini-player; kept for the app session.
  Offset? miniPosition;

  ActiveLive? get current => _current;

  @override
  ActiveLive? build() {
    ref.listen(sessionProvider, (_, next) {
      if (next.hasValue && next.value == null) close();
    });
    // Swiping the PiP window away means "stop watching". A host's live keeps running
    // (they can come back to it); the stale-room sweep covers a killed process.
    final dismissed = ref.read(pipServiceProvider).dismissed.listen((_) {
      final c = _current?.controller;
      if (c != null && !c.isHost) close();
    });
    ref.onDispose(() {
      unawaited(dismissed.cancel());
      _release(_current?.controller);
    });
    return null;
  }

  /// The controller for [roomId]. Reuses the active one when it is the same room, so
  /// re-opening a minimized live restores it without rejoining. Returns null while the
  /// user is hosting a different live: one session at a time, and a host can't leave theirs.
  LiveRoomController? attach(String roomId, {LiveSession? hostSession}) {
    final cur = _current;
    if (cur != null && cur.roomId == roomId) {
      _set(ActiveLive(cur.controller));
      return cur.controller;
    }
    if (cur != null &&
        cur.controller.isHost &&
        !_isOver(cur.controller.status)) {
      return null;
    }
    _release(cur?.controller);
    final c = ref.read(liveControllerFactoryProvider)(
      roomId: roomId,
      hostSession: hostSession,
    );
    c.addListener(_onControllerChanged);
    _set(ActiveLive(c));
    unawaited(c.start());
    return c;
  }

  /// The screen for [c] went away. Unless it was minimized, the session ends with it
  /// (route replaced, auth redirect, …).
  void detach(LiveRoomController c) {
    final cur = _current;
    if (cur != null && identical(cur.controller, c) && !cur.minimized) close();
  }

  /// Back from the full screen: keep watching in the mini-player, unless it's over.
  void minimizeOrClose(LiveRoomController c) {
    final cur = _current;
    if (cur == null || !identical(cur.controller, c)) return;
    if (_isOver(c.status)) return close();
    _set(ActiveLive(c, minimized: true));
  }

  void close() {
    final cur = _current;
    if (cur == null) return;
    _set(null);
    _release(cur.controller);
  }

  /// Hosts the end flow ([LiveRoomController.end]) and then closes.
  Future<Json?> endHosting() async {
    final c = _current?.controller;
    if (c == null || !c.isHost) return null;
    final summary = await c.end();
    if (identical(_current?.controller, c)) close();
    return summary;
  }

  void _onControllerChanged() {
    final cur = _current;
    if (cur == null) return;
    _syncPip();
    if (!cur.minimized || !_isOver(cur.controller.status)) return;
    // The full screen reacts to these itself; the mini-player just goes away.
    final message = switch (cur.controller.status) {
      LiveStatus.kicked => 'You were removed from the live',
      LiveStatus.failed => 'Lost connection to the live',
      _ when cur.controller.isHost => 'Your live has ended',
      _ => 'The live has ended',
    };
    // We're inside the controller's notifyListeners: drop it now, dispose it after.
    final c = cur.controller;
    _set(null);
    c.removeListener(_onControllerChanged);
    scheduleMicrotask(c.dispose);
    liveMessengerKey.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _set(ActiveLive? next) {
    _current = next;
    _syncPip();
    if (_publishScheduled) return;
    _publishScheduled = true;
    scheduleMicrotask(() {
      _publishScheduled = false;
      if (ref.mounted) state = _current;
    });
  }

  /// Arms Android PiP while there is something live to show.
  void _syncPip() {
    final c = _current?.controller;
    final on =
        c != null &&
        (c.status == LiveStatus.live || c.status == LiveStatus.reconnecting);
    final pk = on && c.pk != null;
    unawaited(
      ref
          .read(pipServiceProvider)
          .setAutoEnter(on, numerator: pk ? 6 : 9, denominator: pk ? 5 : 16),
    );
  }

  void _release(LiveRoomController? c) {
    if (c == null) return;
    c.removeListener(_onControllerChanged);
    c.dispose();
  }
}
