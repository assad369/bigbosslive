import 'package:bigboss_live/features/agency/agency_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<bool?> ask(WidgetTester tester, String tap) async {
    bool? answer;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async => answer = await confirmAgencyJoin(
              context,
              agencyName: 'Crown',
              action: 'Join',
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Join Crown?'), findsOneWidget);
    // The terms say both rules before the user commits.
    expect(find.textContaining('locked to this agency'), findsOneWidget);
    expect(find.textContaining('can’t send them'), findsOneWidget);
    await tester.tap(find.text(tap));
    await tester.pumpAndSettle();
    return answer;
  }

  testWidgets('joining asks first, with the lock and gifting terms', (
    tester,
  ) async {
    expect(await ask(tester, 'Join'), isTrue);
    expect(await ask(tester, 'Cancel'), isFalse);
  });
}
