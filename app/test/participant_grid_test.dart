import 'package:bigboss_live/features/live/live_stage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('lays out every stage size from 2 to 13 without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 520);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    for (var n = 2; n <= 13; n++) {
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 390,
            height: 500,
            child: ParticipantGrid(
              tiles: [
                for (var i = 0; i < n; i++)
                  ColoredBox(key: ValueKey('t$i'), color: Colors.black),
              ],
            ),
          ),
        ),
      );
      for (var i = 0; i < n; i++) {
        expect(
          find.byKey(ValueKey('t$i')),
          findsOneWidget,
          reason: 'n=$n i=$i',
        );
      }
      expect(tester.takeException(), isNull, reason: 'n=$n');
    }
  });

  testWidgets('the host tile is the largest from five people up', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 520);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    for (final n in [5, 9, 10, 13]) {
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 390,
            height: 500,
            child: ParticipantGrid(
              tiles: [
                for (var i = 0; i < n; i++)
                  ColoredBox(key: ValueKey('t$i'), color: Colors.black),
              ],
            ),
          ),
        ),
      );
      final host = tester.getSize(find.byKey(const ValueKey('t0')));
      final guest = tester.getSize(find.byKey(ValueKey('t${n - 1}')));
      expect(host.width * host.height, greaterThan(guest.width * guest.height));
    }
  });
}
