import 'package:bigboss_live/core/utils/format.dart';
import 'package:bigboss_live/features/agency/agency_widgets.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TopAgency top(int rank) => TopAgency(
    agency: const AgencySummary(
      id: 'a1',
      code: 'HA-12345678',
      name: 'A remarkably long agency name that has to truncate',
      memberCount: 1234,
    ),
    rank: rank,
    periodDiamonds: 987654321,
  );

  for (final rank in [1, 2, 3, 12]) {
    for (final (width, scale) in [(300.0, 1.0), (300.0, 2.0), (420.0, 1.0)]) {
      testWidgets('rank $rank fits ${width}px at ${scale}x text', (
        tester,
      ) async {
        var tapped = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: MediaQuery(
              data: MediaQueryData(textScaler: TextScaler.linear(scale)),
              child: Scaffold(
                body: Center(
                  child: SizedBox(
                    width: width,
                    height: 104,
                    child: AgencyRankCard(
                      top: top(rank),
                      onTap: () => tapped++,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        expect(find.text(Fmt.diamonds(987654321)), findsOneWidget);
        expect(find.text(rank <= 3 ? 'NO.$rank' : '#$rank'), findsOneWidget);
        await tester.tap(find.byType(AgencyRankCard));
        expect(tapped, 1);
      });
    }
  }
}
