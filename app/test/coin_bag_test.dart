import 'package:bigboss_live/features/coin_bag/coin_bag_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final opens = DateTime.utc(2026, 11, 21, 12);
  Map<String, dynamic> json({int grabbed = 0, String status = 'active'}) => {
    'id': 'b1',
    'roomId': 'r1',
    'releaser': {'uid': 'u1', 'displayName': 'Asha', 'level': 3},
    'host': {'uid': 'h1', 'displayName': 'Host'},
    'amount': 1000,
    'pool': 900,
    'shareCount': 5,
    'grabbedCount': grabbed,
    'status': status,
    'opensAt': opens.toIso8601String(),
    'expiresAt': opens.add(const Duration(minutes: 3)).toIso8601String(),
  };

  group('CoinBag', () {
    test('parses, and phases follow the server clock', () {
      final bag = CoinBag.tryParse(json())!;
      expect(bag.releaser?.displayName, 'Asha');
      expect(bag.sharesLeft, 5);
      final before = opens.subtract(const Duration(seconds: 10));
      expect(bag.phaseAt(before), CoinBagPhase.countdown);
      expect(bag.remainingAt(before), const Duration(seconds: 10));
      expect(bag.phaseAt(opens), CoinBagPhase.open);
      expect(
        bag.phaseAt(opens.add(const Duration(minutes: 3))),
        CoinBagPhase.closed,
      );
    });

    test('is closed when every share is taken or the server closed it', () {
      expect(
        CoinBag.tryParse(json(grabbed: 5))!.phaseAt(opens),
        CoinBagPhase.closed,
      );
      expect(
        CoinBag.tryParse(json(status: 'cancelled'))!.phaseAt(opens),
        CoinBagPhase.closed,
      );
    });

    test('rejects malformed bags', () {
      expect(CoinBag.tryParse({'id': 'x'}), isNull);
      expect(CoinBag.tryParse('nope'), isNull);
    });
  });

  test('config mirrors the server fee split', () {
    final c = CoinBagConfig.fromJson({
      'enabled': true,
      'amountOptions': [1001, 10000],
      'shareOptions': [5, 10],
      'feeRate': 0.1,
      'minShare': 100,
      'canRelease': true,
    });
    expect(c.breakdown(1001), (fee: 100, pool: 901));
    expect(c.splittable(1001, 5), isTrue);
    expect(c.splittable(1001, 10), isFalse);
  });

  test('server clock offset', () {
    final clock = ServerClock()
      ..sync(DateTime.now().add(const Duration(minutes: 10)).toIso8601String());
    expect(
      clock.now().difference(DateTime.now()).inMinutes,
      inInclusiveRange(9, 10),
    );
  });

  test('tap action: here, remote host, seated, elsewhere', () {
    CoinBagTapAction act({
      String? room = 'r2',
      bool host = false,
      bool seat = false,
    }) => coinBagTapAction(
      bagRoomId: 'r1',
      myRoomId: room,
      isHost: host,
      onSeat: seat,
    );
    expect(act(room: 'r1', host: true), CoinBagTapAction.grabHere);
    expect(act(host: true), CoinBagTapAction.grabRemote);
    expect(act(seat: true), CoinBagTapAction.leaveSeatThenGo);
    expect(act(), CoinBagTapAction.go);
  });
}
