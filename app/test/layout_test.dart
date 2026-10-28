import 'package:bigboss_live/core/theme/bb_theme.dart';
import 'package:bigboss_live/features/agency/agency_widgets.dart';
import 'package:bigboss_live/features/profile/profile_screens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// A small phone (iPhone SE 1st gen) with the user's text size turned up. Layout errors
/// (RenderFlex overflow, unbounded widths) are reported as test failures.
Future<void> _pumpSmall(
  WidgetTester tester,
  Widget child, {
  Size size = const Size(320, 568),
  double textScale = 1.3,
}) async {
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        theme: BBTheme.light(),
        home: MediaQuery(
          data: MediaQueryData(
            size: size,
            textScaler: TextScaler.linear(textScale),
          ),
          child: Scaffold(body: child),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('agency stat and action grids fit a small phone at 1.3× text', (
    tester,
  ) async {
    await _pumpSmall(
      tester,
      ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const AgencyStatGrid(
            children: [
              AgencyStat(
                icon: Icons.timer,
                label: 'Live time this month',
                value: '123h 45m',
              ),
              AgencyStat(
                icon: Icons.payments,
                label: 'Commission all time',
                value: '🫘 12.3M',
              ),
            ],
          ),
          const SizedBox(height: 16),
          AgencyStatGrid(
            actions: true,
            children: [
              AgencyActionTile(
                icon: Icons.how_to_reg,
                label: 'Applications',
                badge: 120,
                onTap: () {},
              ),
              AgencyActionTile(
                icon: Icons.settings,
                label: 'Agency settings',
                onTap: () {},
              ),
            ],
          ),
        ],
      ),
    );
    expect(find.text('123h 45m'), findsOneWidget);
    expect(find.text('99+'), findsOneWidget);
  });

  testWidgets('the report sheet scrolls instead of overflowing', (
    tester,
  ) async {
    await _pumpSmall(
      tester,
      const ReportSheet(targetType: 'user', targetId: 'u1'),
    );
    await tester.scrollUntilVisible(
      find.text('Submit report'),
      100,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Submit report'), findsOneWidget);
  });

  testWidgets('themed buttons size to their label in rows and list tiles', (
    tester,
  ) async {
    // Regression: the theme's minimumSize was Size.fromHeight, i.e. infinitely wide, which
    // throws in a ListTile's trailing slot and stacks dialog actions full width.
    await _pumpSmall(
      tester,
      ListView(
        children: [
          ListTile(
            title: const Text('Golden frame'),
            trailing: FilledButton(
              onPressed: () {},
              child: const Text('Equip'),
            ),
          ),
          Row(
            children: [
              OutlinedButton(onPressed: () {}, child: const Text('Cancel')),
              FilledButton(onPressed: () {}, child: const Text('Send')),
            ],
          ),
        ],
      ),
    );
    final equip = tester.getSize(find.widgetWithText(FilledButton, 'Equip'));
    expect(equip.width, lessThan(200));
    expect(equip.height, greaterThanOrEqualTo(48));
  });

  testWidgets('dialog actions sit side by side on a typical phone', (
    tester,
  ) async {
    // (On a very narrow screen with large text OverflowBar stacks them, as it should.)
    await _pumpSmall(
      tester,
      size: const Size(390, 844),
      textScale: 1,
      Builder(
        builder: (context) => TextButton(
          onPressed: () => showDialog<void>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Buy?'),
              actions: [
                TextButton(onPressed: () {}, child: const Text('Cancel')),
                FilledButton(onPressed: () {}, child: const Text('Buy')),
              ],
            ),
          ),
          child: const Text('open'),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    final cancel = tester.getCenter(find.text('Cancel'));
    final buy = tester.getCenter(find.text('Buy'));
    expect((cancel.dy - buy.dy).abs(), lessThan(4));
  });
}
