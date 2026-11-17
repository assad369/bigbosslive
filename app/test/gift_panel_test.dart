import 'package:bigboss_live/core/network/api_exception.dart';
import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/gift_panel.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLiveRepo implements LiveRepository {
  _FakeLiveRepo(this.watching);
  final List<UserBrief> watching;

  int? lastLimit;

  @override
  Future<List<UserBrief>> viewers(String roomId, {int? limit}) async {
    lastLimit = limit;
    return watching;
  }

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
  Future<({int diamonds, int receiverCount})> sendGift({
    required String giftId,
    required int quantity,
    required List<String> receiverIds,
    String? roomId,
    bool skipAbsent = false,
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

/// Records each send; [reached] says how many the server gifted (default: all).
class _RecordingEconomy implements EconomyRepository {
  _RecordingEconomy({this.reached});
  final int? reached;
  final sends = <({List<String> receiverIds, bool skipAbsent, String? key})>[];

  @override
  Future<({int diamonds, int receiverCount})> sendGift({
    required String giftId,
    required int quantity,
    required List<String> receiverIds,
    String? roomId,
    bool skipAbsent = false,
    String? idempotencyKey,
  }) async {
    sends.add((
      receiverIds: receiverIds,
      skipAbsent: skipAbsent,
      key: idempotencyKey,
    ));
    return (diamonds: 400, receiverCount: reached ?? receiverIds.length);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

class _FakeContent implements ContentRepository {
  _FakeContent(this.maxReceivers);
  final int maxReceivers;

  @override
  Future<AppConfig> appConfig() async => AppConfig.fromJson({
    'app': {'minSupportedBuild': <String, dynamic>{}},
    'features': <String, dynamic>{},
    'gifts': {'maxReceivers': maxReceivers},
  });

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

/// Scrolls the receiver chip row (the panel's first scrollable) until [text] is on screen.
Future<void> _reveal(WidgetTester tester, String text) async {
  final chip = find.text(text);
  if (chip.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      chip,
      80,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(chip);
  await tester.pump();
}

/// Taps a receiver chip, scrolling the row to it first.
Future<void> _tapChip(WidgetTester tester, String text) async {
  await _reveal(tester, text);
  await tester.tap(find.text(text));
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
    await _reveal(tester, 'Viewers');
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

    await _tapChip(tester, 'Viewers');
    await tester.pumpAndSettle();
    expect(find.text('Gift a viewer'), findsOneWidget);
    expect(find.text('User host'), findsNothing); // me, filtered out
    await tester.tap(find.text('User v2'));
    await tester.pumpAndSettle();

    expect(find.text('Gift a viewer'), findsNothing);
    expect(find.text('No one to gift yet'), findsNothing);
    final chip = tester.widget<FilterChip>(
      find.ancestor(
        of: find.text('User v2'),
        matching: find.byType(FilterChip),
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
    final chips = tester.widgetList<FilterChip>(find.byType(FilterChip));
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

  group('group gifts', () {
    late _RecordingEconomy economy;
    late _FakeLiveRepo live;

    Future<void> pumpPanel(
      WidgetTester tester, {
      required String me,
      required List<UserBrief> stage,
      List<UserBrief> watching = const [],
      int maxReceivers = 100,
      int? reached,
    }) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      economy = _RecordingEconomy(reached: reached);
      live = _FakeLiveRepo(watching);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionProvider.overrideWith(_FakeSession.new),
            giftsProvider.overrideWith((ref) async => const [_rose]),
            liveRepo.overrideWithValue(live),
            economyRepo.overrideWithValue(economy),
            contentRepo.overrideWithValue(_FakeContent(maxReceivers)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: GiftPanel(
                roomId: 'r1',
                myUid: me,
                hostId: 'host',
                stage: stage,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Rose'));
      await tester.pump();
    }

    Future<void> sendAndConfirm(WidgetTester tester) async {
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      // The dialog's own Send.
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pumpAndSettle();
    }

    testWidgets('"All on stage" gifts the host and guests without me', (
      tester,
    ) async {
      await pumpPanel(
        tester,
        me: 'g1',
        stage: [_user('host'), _user('g1'), _user('g2'), _user('g3')],
      );
      await _tapChip(tester, 'All on stage · 3');
      await tester.pump();
      expect(find.text('To 3 people · '), findsOneWidget);

      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      expect(find.text('Send to 3 people?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pumpAndSettle();

      expect(economy.sends, hasLength(1));
      expect(economy.sends.single.receiverIds, ['host', 'g2', 'g3']);
      expect(economy.sends.single.skipAbsent, isTrue);

      // The same combo again doesn't ask twice, and is a new gift (new key).
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      expect(find.text('Send to 3 people?'), findsNothing);
      expect(economy.sends, hasLength(2));
      expect(economy.sends[1].key, isNot(economy.sends[0].key));
    });

    testWidgets(
      '"Everyone" adds the viewers to the stage, deduped and capped',
      (tester) async {
        await pumpPanel(
          tester,
          me: 'v1',
          stage: [_user('host'), _user('g1')],
          watching: [
            _user('host'),
            _user('v1'),
            _user('v2'),
            _user('v3'),
            _user('v4'),
          ],
          maxReceivers: 4,
        );
        await _tapChip(tester, 'Everyone');
        await tester.pumpAndSettle();
        expect(live.lastLimit, 4);
        expect(find.text('Everyone · 4'), findsOneWidget);

        await tester.tap(find.text('Send'));
        await tester.pumpAndSettle();
        expect(find.textContaining('the first 4 in this live'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Send'));
        await tester.pumpAndSettle();
        expect(economy.sends.single.receiverIds, ['host', 'g1', 'v2', 'v3']);
        expect(economy.sends.single.skipAbsent, isTrue);
      },
    );

    testWidgets('chips pick several people; one person sends without asking', (
      tester,
    ) async {
      await pumpPanel(
        tester,
        me: 'g1',
        stage: [_user('host'), _user('g1'), _user('g2')],
      );
      // The host is picked first; a single send goes straight out.
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();
      expect(economy.sends.single.receiverIds, ['host']);
      expect(economy.sends.single.skipAbsent, isFalse);

      await _tapChip(tester, 'User g2');
      await tester.pump();
      expect(find.text('To 2 people · '), findsOneWidget);
      await sendAndConfirm(tester);
      expect(economy.sends.last.receiverIds, ['host', 'g2']);

      // Unpicking everyone leaves nothing to send.
      await _tapChip(tester, 'User host');
      await _tapChip(tester, 'User g2');
      await tester.pump();
      final send = tester.widget<GoldButton>(find.byType(GoldButton));
      expect(send.onPressed, isNull);
    });

    testWidgets('says when some had left before the gift landed', (
      tester,
    ) async {
      await pumpPanel(
        tester,
        me: 'g1',
        stage: [_user('host'), _user('g1'), _user('g2'), _user('g3')],
        reached: 2,
      );
      await _tapChip(tester, 'All on stage · 3');
      await tester.pump();
      await sendAndConfirm(tester);
      expect(find.text('Sent to 2 — 1 had left the live'), findsOneWidget);
    });
  });
}
