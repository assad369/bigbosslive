import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import 'coin_bag_models.dart';

/// Socket events (`SOCKET.app.coinBag*`).
const coinBagReleasedEvent = 'coinbag:released';
const coinBagUpdatedEvent = 'coinbag:updated';
const coinBagClosedEvent = 'coinbag:closed';

/// Release options and whether I may release; reloaded each time a live room opens.
final coinBagConfigProvider = FutureProvider.autoDispose<CoinBagConfig>((
  ref,
) async {
  final r = await ref.watch(coinBagRepo).config();
  ref.read(coinBagsProvider.notifier).clock.sync(r.serverNow);
  return r.config;
});

@immutable
class CoinBagsState {
  const CoinBagsState({this.bags = const [], this.grabbed = const {}});

  /// Running bags, newest first.
  final List<CoinBag> bags;

  /// What I grabbed, by bag id.
  final Map<String, int> grabbed;

  CoinBagsState copyWith({List<CoinBag>? bags, Map<String, int>? grabbed}) =>
      CoinBagsState(bags: bags ?? this.bags, grabbed: grabbed ?? this.grabbed);
}

/// Every running coin bag on the platform, kept live by the socket while a live room is open.
/// Loaded on open and on every socket reconnect; the socket then adds, updates and removes.
class CoinBagsController extends Notifier<CoinBagsState> {
  final clock = ServerClock();
  final _released = StreamController<CoinBag>.broadcast();

  /// Bags released by someone else while I watch: the slide-in banner.
  Stream<CoinBag> get released => _released.stream;

  @override
  CoinBagsState build() {
    final socket = ref.watch(socketProvider);
    final subs = [
      socket.on(coinBagReleasedEvent).listen(_onReleased),
      socket.on(coinBagUpdatedEvent).listen(_onUpdated),
      socket.on(coinBagClosedEvent).listen(_onClosed),
    ];
    ref.onDispose(() {
      for (final s in subs) {
        unawaited(s.cancel());
      }
      unawaited(_released.close());
    });
    unawaited(refresh());
    return const CoinBagsState();
  }

  Future<void> refresh() async {
    try {
      final r = await ref.read(coinBagRepo).active();
      if (!ref.mounted) return;
      clock.sync(r.serverNow);
      state = CoinBagsState(bags: r.bags, grabbed: r.grabbed);
    } catch (e) {
      // The socket keeps the list going; the next room open or reconnect reloads it.
      debugPrint('coin bags: $e');
    }
  }

  void _onReleased(Map<String, dynamic> p) {
    clock.sync(p['serverNow'] as String?);
    final bag = CoinBag.tryParse(p['bag']);
    if (bag == null) return;
    upsert(bag);
    if (!_released.isClosed) _released.add(bag);
  }

  void _onUpdated(Map<String, dynamic> p) {
    clock.sync(p['serverNow'] as String?);
    final id = p['bagId'];
    final count = p['grabbedCount'];
    if (id is! String || count is! num) return;
    state = state.copyWith(
      bags: [
        for (final b in state.bags)
          // Never backwards: a late update must not undo a newer local count.
          b.id == id && count > b.grabbedCount
              ? b.copyWith(grabbedCount: count.toInt())
              : b,
      ],
    );
  }

  void _onClosed(Map<String, dynamic> p) {
    clock.sync(p['serverNow'] as String?);
    final id = p['bagId'];
    if (id is! String) return;
    state = state.copyWith(bags: state.bags.where((b) => b.id != id).toList());
  }

  /// A bag I just released (or one the socket announced), newest first.
  void upsert(CoinBag bag) {
    state = state.copyWith(
      bags: [bag, ...state.bags.where((b) => b.id != bag.id)],
    );
  }

  /// Grabs a share and records it. Throws the server's refusal.
  Future<CoinBagGrab> grab(String bagId) async {
    final got = await ref.read(coinBagRepo).grab(bagId);
    state = state.copyWith(
      grabbed: {...state.grabbed, bagId: got.amount},
      bags: [
        for (final b in state.bags)
          b.id == bagId && !got.duplicate
              ? b.copyWith(grabbedCount: b.grabbedCount + 1)
              : b,
      ],
    );
    final me = ref.read(sessionProvider).value;
    if (me != null) {
      ref.read(sessionProvider.notifier).replace(me.withDiamonds(got.balance));
    }
    return got;
  }

  /// Drops a bag the server says is over (grabbed out or closed) before its event arrives.
  void drop(String bagId) {
    state = state.copyWith(
      bags: state.bags.where((b) => b.id != bagId).toList(),
    );
  }
}

final coinBagsProvider =
    NotifierProvider.autoDispose<CoinBagsController, CoinBagsState>(
      CoinBagsController.new,
    );
