import 'package:bigboss_live/core/theme/bb_colors.dart';
import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/core/utils/json.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

void main() {
  testWidgets('GoldButton fires and shows a spinner while loading', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(
      _wrap(GoldButton(label: 'Go live', onPressed: () => taps++)),
    );
    await tester.tap(find.text('Go live'));
    expect(taps, 1);

    await tester.pumpWidget(
      _wrap(
        GoldButton(label: 'Go live', loading: true, onPressed: () => taps++),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.tap(find.byType(GoldButton));
    expect(taps, 1);
  });

  testWidgets('LevelBadge and VipBadge render', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const Row(
          mainAxisSize: MainAxisSize.min,
          children: [LevelBadge(42), VipBadge(3), VipBadge(0)],
        ),
      ),
    );
    expect(find.text('Lv 42'), findsOneWidget);
    expect(find.text('VIP3'), findsOneWidget);
    expect(find.text('VIP0'), findsNothing);
  });

  test('level tiers use the gold gradient in the gold band', () {
    expect(LevelBadge.gradientFor(45), BBColors.goldGradient);
    expect(LevelBadge.gradientFor(5), BBColors.bronzeGradient);
  });

  testWidgets('BBAvatar falls back to an initial', (tester) async {
    await tester.pumpWidget(_wrap(const BBAvatar(name: 'amira')));
    expect(find.text('A'), findsOneWidget);
  });

  testWidgets('PagedList loads pages, shows empty state, and retries errors', (
    tester,
  ) async {
    var calls = 0;
    await tester.pumpWidget(
      _wrap(
        SizedBox(
          height: 400,
          child: PagedList<String>(
            load: (cursor) async {
              calls++;
              return Paged(
                items: cursor == null ? ['a', 'b'] : ['c'],
                nextCursor: cursor == null ? 'next' : null,
              );
            },
            itemBuilder: (_, s) => SizedBox(height: 40, child: Text(s)),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('a'), findsOneWidget);
    expect(find.text('c'), findsOneWidget);
    expect(calls, 2);

    await tester.pumpWidget(
      _wrap(
        SizedBox(
          height: 400,
          child: PagedList<String>(
            key: const ValueKey('empty'),
            load: (_) async => const Paged(items: []),
            itemBuilder: (_, s) => Text(s),
            empty: const Text('Nothing'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Nothing'), findsOneWidget);
  });
}
