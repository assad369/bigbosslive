import 'package:flutter/foundation.dart';

import '../../core/utils/json.dart';
import '../../models/models.dart';

/// Where a coin bag is in its life, by the server clock.
enum CoinBagPhase { countdown, open, closed }

/// The server's clock, estimated from the last `serverNow` it sent, so every phone counts a
/// bag's countdown down to the same moment whatever its own clock says.
class ServerClock {
  ServerClock([this.offset = Duration.zero]);

  /// Server time minus device time.
  Duration offset;

  void sync(String? serverNow) {
    final at = serverNow == null ? null : DateTime.tryParse(serverNow);
    if (at != null) offset = at.difference(DateTime.now());
  }

  DateTime now() => DateTime.now().add(offset);
}

/// A running (or just closed) coin bag. Never carries the share amounts.
@immutable
class CoinBag {
  const CoinBag({
    required this.id,
    required this.roomId,
    required this.amount,
    required this.pool,
    required this.shareCount,
    required this.grabbedCount,
    required this.status,
    required this.opensAt,
    required this.expiresAt,
    this.releaser,
    this.host,
  });

  final String id;
  final String roomId;
  final UserBrief? releaser;
  final UserBrief? host;
  final int amount;

  /// What grabbers share: [amount] less the platform fee.
  final int pool;
  final int shareCount;
  final int grabbedCount;
  final String status;
  final DateTime opensAt;
  final DateTime expiresAt;

  int get sharesLeft => (shareCount - grabbedCount).clamp(0, shareCount);

  static CoinBag? tryParse(Object? j) {
    if (j is! Map) return null;
    final m = j.map((k, v) => MapEntry('$k', v));
    final opensAt = m.date('opensAt');
    final expiresAt = m.date('expiresAt');
    if (m.str('id').isEmpty || opensAt == null || expiresAt == null) {
      return null;
    }
    UserBrief? brief(String k) =>
        m.objOrNull(k) == null ? null : UserBrief.fromJson(m.obj(k));
    return CoinBag(
      id: m.str('id'),
      roomId: m.str('roomId'),
      releaser: brief('releaser'),
      host: brief('host'),
      amount: m.integer('amount'),
      pool: m.integer('pool'),
      shareCount: m.integer('shareCount', 1),
      grabbedCount: m.integer('grabbedCount'),
      status: m.str('status', 'active'),
      opensAt: opensAt,
      expiresAt: expiresAt,
    );
  }

  CoinBag copyWith({int? grabbedCount, String? status}) => CoinBag(
    id: id,
    roomId: roomId,
    releaser: releaser,
    host: host,
    amount: amount,
    pool: pool,
    shareCount: shareCount,
    grabbedCount: grabbedCount ?? this.grabbedCount,
    status: status ?? this.status,
    opensAt: opensAt,
    expiresAt: expiresAt,
  );

  CoinBagPhase phaseAt(DateTime serverNow) {
    if (status != 'active' ||
        sharesLeft == 0 ||
        !serverNow.isBefore(expiresAt)) {
      return CoinBagPhase.closed;
    }
    return serverNow.isBefore(opensAt)
        ? CoinBagPhase.countdown
        : CoinBagPhase.open;
  }

  /// Until it opens during the countdown, until it ends once open.
  Duration remainingAt(DateTime serverNow) {
    final d = switch (phaseAt(serverNow)) {
      CoinBagPhase.countdown => opensAt.difference(serverNow),
      CoinBagPhase.open => expiresAt.difference(serverNow),
      CoinBagPhase.closed => Duration.zero,
    };
    return d.isNegative ? Duration.zero : d;
  }
}

/// `GET /coin-bags/config`: the release options and whether I may release.
@immutable
class CoinBagConfig {
  const CoinBagConfig({
    required this.enabled,
    required this.amountOptions,
    required this.shareOptions,
    required this.feeRate,
    required this.minShare,
    required this.countdownSec,
    required this.grabWindowSec,
    required this.canRelease,
    this.refusal,
  });

  final bool enabled;
  final List<int> amountOptions;
  final List<int> shareOptions;
  final double feeRate;
  final int minShare;
  final int countdownSec;
  final int grabWindowSec;
  final bool canRelease;

  /// Why I can't release, in words, when [canRelease] is false.
  final String? refusal;

  factory CoinBagConfig.fromJson(Json j) => CoinBagConfig(
    enabled: j.flag('enabled'),
    amountOptions: _ints(j['amountOptions']),
    shareOptions: _ints(j['shareOptions']),
    feeRate: j.dbl('feeRate'),
    minShare: j.integer('minShare', 1),
    countdownSec: j.integer('countdownSec', 30),
    grabWindowSec: j.integer('grabWindowSec', 180),
    canRelease: j.flag('canRelease'),
    refusal: j.objOrNull('refusal')?.strOrNull('message'),
  );

  /// The server's split: the fee is floored.
  ({int fee, int pool}) breakdown(int amount) {
    final fee = (amount * feeRate).floor();
    return (fee: fee, pool: amount - fee);
  }

  /// Whether [amount] covers [shares] shares of at least [minShare].
  bool splittable(int amount, int shares) =>
      breakdown(amount).pool >= shares * minShare;

  static List<int> _ints(Object? v) => v is List
      ? [
          for (final x in v)
            if (x is num) x.toInt(),
        ]
      : const [];
}

/// What tapping a bag does, from where I am.
enum CoinBagTapAction {
  /// It is in this room.
  grabHere,

  /// I host another live: grab from here.
  grabRemote,

  /// I'm on a seat in another room: leave it (after asking), then go.
  leaveSeatThenGo,

  /// Go to its room.
  go,
}

CoinBagTapAction coinBagTapAction({
  required String bagRoomId,
  required String? myRoomId,
  required bool isHost,
  required bool onSeat,
}) {
  if (bagRoomId == myRoomId) return CoinBagTapAction.grabHere;
  if (isHost) return CoinBagTapAction.grabRemote;
  if (onSeat) return CoinBagTapAction.leaveSeatThenGo;
  return CoinBagTapAction.go;
}

/// What a grab got me.
typedef CoinBagGrab = ({int amount, bool remote, int balance, bool duplicate});
