import 'package:bigboss_live/core/network/api_exception.dart';
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

MeUser _me({String? agencyId}) => MeUser.fromJson({
  'id': 'me',
  'shortId': '1',
  'displayName': 'Me',
  'agencyId': agencyId,
  'wallet': {'diamonds': 500, 'agentStock': 0},
  'levelProgress': {
    'level': 1,
    'points': 0,
    'currentLevelPoints': 0,
    'nextLevelPoints': 10,
    'isMaxLevel': false,
  },
});

class _FakeSession extends SessionController {
  @override
  Future<MeUser?> build() async => _me();
}

class _MemberSession extends SessionController {
  @override
  Future<MeUser?> build() async => _me(agencyId: 'a1');
}

/// The server refuses the gift because the account joined an agency meanwhile.
class _RefusingEconomy implements EconomyRepository {
  int sends = 0;

  @override
  Future<int> sendGift({
    required String giftId,
    required int quantity,
    required List<String> receiverIds,
    String? roomId,
    String? idempotencyKey,
  }) async {
    sends++;
    throw const ApiException(
      403,
      'agency_member_gift_blocked',
      "Agency hosts can't send gifts",
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

/// `/me` after joining: now an agency member.
class _MemberAccount implements AccountRepository {
  @override
  Future<MeUser> me() async => _me(agencyId: 'a1');

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

const _rose = Gift(
  id: 'g1',
  name: 'Rose',
  price: 10,
  iconUrl: '',
  animationFormat: 'none',
  category: 'popular',
  vipTierRequired: 0,
);

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

  testWidgets('an agency member sees why they can\'t gift instead of Send', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionProvider.overrideWith(_MemberSession.new),
          giftsProvider.overrideWith((ref) async => const [_rose]),
          liveRepo.overrideWithValue(_FakeLiveRepo(const [])),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: GiftPanel(
              roomId: 'r1',
              myUid: 'me',
              hostId: 'host',
              stage: [_user('host')],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Agency hosts can’t gift'), findsOneWidget);
    expect(find.text('Send'), findsNothing);
    // Browsing still works.
    expect(find.text('Rose'), findsOneWidget);
  });

  testWidgets('everyone else gets Send', (tester) async {
    await tester.pumpWidget(_panel(me: 'me', stage: [_user('host')]));
    await tester.pump();
    expect(find.text('Send'), findsOneWidget);
    expect(find.text('Agency hosts can’t gift'), findsNothing);
  });

  testWidgets('a refusal for a fresh membership explains and locks the panel', (
    tester,
  ) async {
    // A phone, so the gift tile is inside the panel's grid.
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final economy = _RefusingEconomy();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionProvider.overrideWith(_FakeSession.new),
          giftsProvider.overrideWith((ref) async => const [_rose]),
          liveRepo.overrideWithValue(_FakeLiveRepo(const [])),
          economyRepo.overrideWithValue(economy),
          accountRepo.overrideWithValue(_MemberAccount()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: GiftPanel(
              roomId: 'r1',
              myUid: 'me',
              hostId: 'host',
              stage: [_user('host')],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Rose'));
    await tester.pump();
    await tester.tap(find.text('Send'));
    await tester.pump();
    await tester.pump();
    expect(economy.sends, 1);
    expect(find.text("Agency hosts can't send gifts"), findsOneWidget);
    expect(find.text('Agency hosts can’t gift'), findsOneWidget);
    expect(find.text('Send'), findsNothing);
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
