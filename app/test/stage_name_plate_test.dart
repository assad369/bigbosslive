import 'package:bigboss_live/core/theme/bb_colors.dart';
import 'package:bigboss_live/core/utils/format.dart';
import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/features/live/live_stage.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const user = UserBrief(
    id: 'u1',
    shortId: '201',
    displayName: 'A very long co-host display name that must truncate',
    level: 42,
    vipTier: 2,
  );
  const diamonds = 123456789;

  Future<void> pump(
    WidgetTester tester, {
    required bool compact,
    double? width,
    double textScale = 1,
  }) => tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
        child: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width ?? (compact ? 68 : 180),
              child: StageNamePlate(
                user: user,
                diamonds: diamonds,
                isHost: true,
                compact: compact,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  for (final compact in [false, true]) {
    testWidgets('avatar left, diamonds under the name (compact: $compact)', (
      tester,
    ) async {
      await pump(tester, compact: compact);
      expect(tester.takeException(), isNull);

      final name = find.textContaining(user.displayName);
      final amount = find.text(Fmt.full(diamonds));
      final avatar = find.byType(BBAvatar);
      expect(name, findsOneWidget);
      expect(amount, findsOneWidget);
      expect(avatar, findsOneWidget);
      // The level stays in the profile sheet: the tile's line 1 is the name alone.
      expect(find.text('Lv ${user.level}'), findsNothing);
      expect(find.byType(LevelBadge), findsNothing);

      // Line 2 sits under line 1, and both sit right of the avatar.
      expect(
        tester.getTopLeft(amount).dy,
        greaterThanOrEqualTo(tester.getBottomLeft(name).dy),
      );
      expect(
        tester.getTopRight(avatar).dx,
        lessThanOrEqualTo(tester.getTopLeft(name).dx),
      );
      expect(
        tester.getTopRight(avatar).dx,
        lessThanOrEqualTo(tester.getTopLeft(amount).dx),
      );

      // No role or VIP badges either.
      expect(find.byType(RoleBadge), findsNothing);
      expect(find.byType(VipTag), findsNothing);
      expect(find.text('Host'), findsNothing);
    });
  }

  testWidgets('balance keeps its diamonds label for screen readers', (
    tester,
  ) async {
    await pump(tester, compact: false);
    expect(
      find.bySemanticsLabel('${Fmt.full(diamonds)} diamonds'),
      findsOneWidget,
    );
  });

  testWidgets('no dark box behind the plate: the text carries a shadow', (
    tester,
  ) async {
    await pump(tester, compact: false);
    final boxes = find.descendant(
      of: find.byType(StageNamePlate),
      matching: find.byWidgetPredicate(
        (w) =>
            (w is Container &&
                w.decoration is BoxDecoration &&
                (w.decoration! as BoxDecoration).color != null) ||
            (w is DecoratedBox &&
                w.decoration is BoxDecoration &&
                (w.decoration as BoxDecoration).color == BBColors.scrim),
      ),
    );
    expect(boxes, findsNothing);
    final name = tester.widget<Text>(find.textContaining(user.displayName));
    expect(name.style?.shadows, isNotEmpty);
  });

  testWidgets('a narrow tile gives the avatar\'s room to the name', (
    tester,
  ) async {
    await pump(tester, compact: true, width: 48);
    expect(tester.takeException(), isNull);
    expect(find.byType(BBAvatar), findsNothing);
    expect(find.textContaining(user.displayName), findsOneWidget);
  });

  testWidgets('the name grows with the tile and stays on one line', (
    tester,
  ) async {
    double font() => tester
        .widget<Text>(find.textContaining(user.displayName))
        .style!
        .fontSize!;
    await pump(tester, compact: true, width: 90);
    final small = font();
    await pump(tester, compact: false, width: 200);
    final large = font();
    expect(large, greaterThan(small));
    final text = tester.widget<Text>(find.textContaining(user.displayName));
    expect(text.maxLines, 1);
    expect(text.overflow, TextOverflow.ellipsis);
  });

  testWidgets('very large system text does not overflow a small tile', (
    tester,
  ) async {
    await pump(tester, compact: true, width: 68, textScale: 2.5);
    expect(tester.takeException(), isNull);
  });
}
