import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/vip_tier.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/store/tier_packages_screen.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

MeUser _me() => MeUser.fromJson({
  'id': 'me',
  'shortId': '1',
  'displayName': 'Me',
  'wallet': {'diamonds': 5000, 'agentStock': 0},
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

  @override
  Future<void> refresh() async {}
}

const _gold = TierPackage(
  id: 'gold',
  tier: 4,
  name: 'Gold King',
  priceDiamonds: 1200,
  durationDays: 30,
);
const _ruby = TierPackage(
  id: 'ruby',
  tier: 4,
  name: 'Ruby King',
  priceDiamonds: 900,
  durationDays: 7,
);
// Owned, no longer on sale.
const _retired = TierPackage(
  id: 'retired',
  tier: 4,
  name: 'Event King',
  priceDiamonds: 0,
  durationDays: 3,
);

class _FakeEconomy implements EconomyRepository {
  _FakeEconomy({this.shop = const [], this.mine = const []});
  final List<TierPackage> shop;
  final List<OwnedTierPackage> mine;
  final worn = <String?>[];

  @override
  Future<List<TierPackage>> tierPackages(int tier) async => shop;

  @override
  Future<List<OwnedTierPackage>> myTierPackages(int tier) async => mine;

  @override
  Future<void> wearTierPackage(String? id) async => worn.add(id);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

/// The screen sits below the auth gate, so the session is loaded before it builds.
Future<void> _pump(WidgetTester tester, _FakeEconomy economy) async {
  final container = ProviderContainer(
    overrides: [
      sessionProvider.overrideWith(_FakeSession.new),
      economyRepo.overrideWithValue(economy),
    ],
  );
  addTearDown(container.dispose);
  await container.read(sessionProvider.future);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: TierPackagesScreen(tier: VipTier.king)),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _button(String label) => find.ancestor(
  of: find.text(label),
  matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
);

void main() {
  final until = DateTime.now().add(const Duration(days: 10));

  testWidgets('the shop lists price, validity and Buy for a package not held', (
    tester,
  ) async {
    await _pump(tester, _FakeEconomy(shop: [_gold]));

    expect(find.text('KING Package'), findsOneWidget);
    expect(find.text('KING Package:'), findsOneWidget);
    expect(find.text('My KING'), findsOneWidget);
    expect(find.text('Gold King'), findsOneWidget);
    expect(find.text('1,200'), findsOneWidget);
    expect(find.text('30 days validity'), findsOneWidget);
    expect(_button('Buy'), findsOneWidget);
    expect(find.text('Extend'), findsNothing);
  });

  testWidgets(
    'a worn package shows Extend and In use; another owned shows Use',
    (tester) async {
      await _pump(
        tester,
        _FakeEconomy(
          shop: [_gold, _ruby],
          mine: [
            OwnedTierPackage(package: _gold, expiresAt: until, worn: true),
            OwnedTierPackage(package: _ruby, expiresAt: until),
          ],
        ),
      );

      expect(find.textContaining('In use · Until'), findsOneWidget);
      expect(_button('Extend'), findsNWidgets(2));
      expect(_button('In use'), findsOneWidget);
      expect(_button('Use'), findsOneWidget);
      expect(find.text('Buy'), findsNothing);
    },
  );

  testWidgets('tapping In use takes the package off', (tester) async {
    final economy = _FakeEconomy(
      shop: [_gold],
      mine: [OwnedTierPackage(package: _gold, expiresAt: until, worn: true)],
    );
    await _pump(tester, economy);

    await tester.tap(_button('In use'));
    await tester.pumpAndSettle();
    expect(economy.worn, [null]);
  });

  testWidgets('Buy asks first, with the price and days', (tester) async {
    await _pump(tester, _FakeEconomy(shop: [_gold]));

    await tester.tap(_button('Buy'));
    await tester.pumpAndSettle();
    expect(find.text('Buy Gold King?'), findsOneWidget);
    expect(find.textContaining('+30 days'), findsOneWidget);
  });

  testWidgets('my packages: expired cannot be used; retired has no Extend', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeEconomy(
        shop: [_gold],
        mine: [
          OwnedTierPackage(
            package: _gold,
            expiresAt: DateTime.now().subtract(const Duration(days: 1)),
            expired: true,
          ),
          OwnedTierPackage(package: _retired, expiresAt: until),
        ],
      ),
    );
    await tester.tap(find.text('My KING'));
    await tester.pumpAndSettle();

    expect(find.text('My KING Package:'), findsOneWidget);
    expect(find.text('Expired'), findsOneWidget);
    final uses = tester.widgetList<ButtonStyleButton>(_button('Use')).toList();
    expect(uses, hasLength(2));
    // The expired one (listed first) is disabled; the retired one can still be worn.
    expect(uses.first.onPressed, isNull);
    expect(uses.last.onPressed, isNotNull);
    // Only the expired, still-on-sale package can be bought again.
    expect(_button('Buy'), findsOneWidget);
    expect(find.text('Extend'), findsNothing);
  });
}
