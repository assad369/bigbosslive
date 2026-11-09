import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/gift_panel.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLiveRepo implements LiveRepository {
  _FakeLiveRepo(this.watching);
  final List<UserBrief> watching;

  @override
  Future<List<UserBrief>> viewers(String roomId) async => watching;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

class _FakeSession extends SessionController {
  @override
  Future<MeUser?> build() async => MeUser.fromJson({
    'id': 'me',
    'shortId': '1',
    'displayName': 'Me',
    'wallet': {'diamonds': 500, 'agentStock': 0},
    'levelProgress': {
      'level': 1,
      'points': 0,
      'currentLevelPoints': 0,
      'nextLevelPoints': 10,
      'isMaxLevel': false,
    },
  });
}

UserBrief _user(String id) =>
    UserBrief(id: id, shortId: '1$id', displayName: 'User $id');

Widget _panel({
  required String me,
  required List<UserBrief> stage,
  List<UserBrief> watching = const [],
  UserBrief? preselected,
}) => ProviderScope(
  overrides: [
    sessionProvider.overrideWith(_FakeSession.new),
    giftsProvider.overrideWith((ref) async => const <Gift>[]),
    liveRepo.overrideWithValue(_FakeLiveRepo(watching)),
  ],
  child: MaterialApp(
    home: Scaffold(
      body: GiftPanel(
        roomId: 'r1',
        myUid: me,
        hostId: 'host',
        stage: stage,
        preselected: preselected,
      ),
    ),
  ),
);

void main() {
  testWidgets('offers the stage first, tagged, without me', (tester) async {
    await tester.pumpWidget(
      _panel(me: 'guest', stage: [_user('host'), _user('guest'), _user('g2')]),
    );
    await tester.pump();
    expect(find.text('User host'), findsOneWidget);
    expect(find.text('Host'), findsOneWidget);
    expect(find.text('User g2'), findsOneWidget);
    expect(find.text('Guest'), findsOneWidget);
    expect(find.text('User guest'), findsNothing); // can't gift myself
    expect(find.text('Viewers'), findsOneWidget);
  });

  testWidgets('a host alone can pick a viewer to gift', (tester) async {
    await tester.pumpWidget(
      _panel(
        me: 'host',
        stage: [_user('host')],
        watching: [_user('host'), _user('v1'), _user('v2')],
      ),
    );
    await tester.pump();
    expect(find.text('No one to gift yet'), findsOneWidget);

    await tester.tap(find.text('Viewers'));
    await tester.pumpAndSettle();
    expect(find.text('Gift a viewer'), findsOneWidget);
    expect(find.text('User host'), findsNothing); // me, filtered out
    await tester.tap(find.text('User v2'));
    await tester.pumpAndSettle();

    expect(find.text('Gift a viewer'), findsNothing);
    expect(find.text('No one to gift yet'), findsNothing);
    final chip = tester.widget<ChoiceChip>(
      find.ancestor(
        of: find.text('User v2'),
        matching: find.byType(ChoiceChip),
      ),
    );
    expect(chip.selected, isTrue);
  });

  testWidgets('a tapped viewer comes first and is selected', (tester) async {
    await tester.pumpWidget(
      _panel(me: 'v1', stage: [_user('host')], preselected: _user('v9')),
    );
    await tester.pump();
    final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip));
    expect(chips.length, 2);
    expect(chips.first.selected, isTrue);
    expect(
      find.descendant(
        of: find.byWidget(chips.first),
        matching: find.text('User v9'),
      ),
      findsOneWidget,
    );
  });
}
