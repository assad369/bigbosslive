import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/live/pk_widgets.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeController extends ChangeNotifier implements LiveRoomController {
  _FakeController(this.pkOutgoing);

  @override
  final PkBattle? pkOutgoing;
  @override
  String get myUid => 'host';
  @override
  Future<void> cancelPkInvite() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('PK countdowns tick on their own', (tester) async {
    // Regression: the ticker's timer was a lazy `late final`, created only in dispose(), so
    // countdowns froze unless something else rebuilt the screen.
    final now = DateTime.now();
    final battle = PkBattle.fromJson({
      'id': 'b1',
      'status': 'pending',
      'invitedBy': 'host',
      'hosts': [
        {'uid': 'host', 'roomId': 'r1', 'displayName': 'Host'},
        {'uid': 'rival', 'roomId': 'r2', 'displayName': 'Rival'},
      ],
      'durationSec': 180,
      'inviteExpiresAt': now
          .add(const Duration(seconds: 30))
          .toUtc()
          .toIso8601String(),
      'serverTime': now.toUtc().toIso8601String(),
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: PkWaitingBanner(c: _FakeController(battle))),
      ),
    );
    String label() =>
        tester.widget<Text>(find.textContaining('Waiting for Rival')).data!;
    final before = label();
    // The countdown reads the real clock; fake time only fires the tick.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 2100)),
    );
    await tester.pump(const Duration(seconds: 1));
    expect(label(), isNot(before));
  });

  testWidgets('an expired invitation never shows negative seconds', (
    tester,
  ) async {
    final now = DateTime.now();
    final battle = PkBattle.fromJson({
      'id': 'b1',
      'status': 'pending',
      'invitedBy': 'host',
      'hosts': [
        {'uid': 'host', 'roomId': 'r1', 'displayName': 'Host'},
        {'uid': 'rival', 'roomId': 'r2', 'displayName': 'Rival'},
      ],
      'inviteExpiresAt': now
          .subtract(const Duration(seconds: 20))
          .toUtc()
          .toIso8601String(),
      'serverTime': now.toUtc().toIso8601String(),
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: PkWaitingBanner(c: _FakeController(battle))),
      ),
    );
    expect(find.textContaining('0s'), findsOneWidget);
    expect(find.textContaining('-'), findsNothing);
  });
}
