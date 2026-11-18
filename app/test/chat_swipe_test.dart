import 'package:bigboss_live/features/live/chat_swipe.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late List<bool> calls;

  Widget room({bool enabled = true, Widget? inner}) => MaterialApp(
    home: MediaQuery(
      data: const MediaQueryData(size: Size(400, 800)),
      child: ChatSwipeDetector(
        enabled: enabled,
        onChatVisible: calls.add,
        child: Stack(
          fit: StackFit.expand,
          children: [
            const ColoredBox(color: Colors.black),
            if (inner != null)
              Align(alignment: Alignment.topCenter, child: inner),
          ],
        ),
      ),
    ),
  );

  setUp(() => calls = []);

  testWidgets('a swipe to the right hides the chat, to the left shows it', (
    tester,
  ) async {
    await tester.pumpWidget(room());
    await tester.flingFrom(const Offset(150, 500), const Offset(200, 0), 1000);
    await tester.pumpAndSettle();
    expect(calls, [false]);
    await tester.flingFrom(const Offset(250, 500), const Offset(-200, 0), 1000);
    await tester.pumpAndSettle();
    expect(calls, [false, true]);
  });

  testWidgets('a slow drag counts once it travels far enough', (tester) async {
    await tester.pumpWidget(room());
    await tester.timedDragFrom(
      const Offset(100, 400),
      const Offset(120, 0),
      const Duration(seconds: 2),
    );
    await tester.pumpAndSettle();
    expect(calls, [false]);
    // A short, slow nudge is ignored.
    await tester.timedDragFrom(
      const Offset(100, 400),
      const Offset(30, 0),
      const Duration(seconds: 2),
    );
    await tester.pumpAndSettle();
    expect(calls, [false]);
  });

  testWidgets(
    'swipes from the screen edge are left to the system back gesture',
    (tester) async {
      await tester.pumpWidget(room());
      await tester.flingFrom(const Offset(5, 500), const Offset(250, 0), 1000);
      await tester.flingFrom(
        const Offset(395, 500),
        const Offset(-250, 0),
        1000,
      );
      await tester.pumpAndSettle();
      expect(calls, isEmpty);
    },
  );

  testWidgets('does nothing while typing', (tester) async {
    await tester.pumpWidget(room(enabled: false));
    await tester.flingFrom(const Offset(150, 500), const Offset(200, 0), 1000);
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
  });

  testWidgets('a horizontal list inside keeps its own drag', (tester) async {
    await tester.pumpWidget(
      room(
        inner: SizedBox(
          height: 60,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (var i = 0; i < 20; i++)
                SizedBox(width: 60, child: Text('$i')),
            ],
          ),
        ),
      ),
    );
    await tester.flingFrom(const Offset(300, 30), const Offset(-200, 0), 1000);
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
  });
}
