import 'package:bigboss_live/core/theme/bb_theme.dart';
import 'package:bigboss_live/features/store/store_screens.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

StoreItem _item({
  bool owned = false,
  bool equipped = false,
  bool included = false,
}) => StoreItem(
  id: 'i1',
  // A background with a still preview needs no network image in the test.
  type: 'room_background',
  name: 'Night sky',
  assetUrl: 'https://cdn.test/sky.svga',
  animationFormat: 'svga',
  priceDiamonds: 1500,
  durationDays: 7,
  vipTierRequired: included ? 2 : 0,
  vipIncluded: included,
  owned: owned,
  ownedUntil: owned ? DateTime(2026, 12, 1) : null,
  equipped: equipped,
);

Future<void> _pump(WidgetTester tester, StoreItem item) => tester.pumpWidget(
  MaterialApp(
    theme: BBTheme.light(),
    home: Scaffold(
      body: SizedBox(
        width: 200,
        height: 240,
        child: StoreItemTile(item: item, onTap: () {}),
      ),
    ),
  ),
);

void main() {
  testWidgets('a tile says Equipped, Owned, Included or the price', (
    tester,
  ) async {
    await _pump(tester, _item(owned: true, equipped: true));
    expect(find.text('Equipped'), findsOneWidget);

    await _pump(tester, _item(owned: true));
    expect(find.text('Owned'), findsOneWidget);
    expect(find.textContaining('Until'), findsOneWidget);

    await _pump(tester, _item(included: true));
    expect(find.text('Included'), findsOneWidget);

    await _pump(tester, _item());
    expect(find.text('Owned'), findsNothing);
    expect(find.text('Equipped'), findsNothing);
    expect(find.textContaining('7 days'), findsOneWidget);
  });
}
