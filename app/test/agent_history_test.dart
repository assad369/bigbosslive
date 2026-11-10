import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/utils/json.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/wallet/wallet_screens.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

MeUser _agent() => MeUser.fromJson({
  'id': 'agent',
  'shortId': '200',
  'displayName': 'Agent',
  'isAgent': true,
  'wallet': {'diamonds': 0, 'agentStock': 2500000},
  'levelProgress': {
    'level': 1,
    'points': 0,
    'currentLevelPoints': 0,
    'nextLevelPoints': 10,
    'isMaxLevel': false,
  },
});

class _AgentSession extends SessionController {
  @override
  Future<MeUser?> build() async => _agent();
}

class _FakeEconomy implements EconomyRepository {
  int stockLoads = 0;

  @override
  Future<AgentSummary> agentSummary() async => const AgentSummary(
    count: 3,
    totalDiamonds: 1234567,
    todayDiamonds: 5000,
    monthDiamonds: 250000,
  );

  @override
  Future<Paged<AgentRecharge>> agentHistory({
    String? cursor,
    String? shortId,
  }) async => Paged(
    items: [
      AgentRecharge.fromJson({
        'id': 'r1',
        'user': {'id': 'u1', 'shortId': '345', 'displayName': 'Buyer'},
        'diamonds': 1500000,
        'createdAt': '2026-11-01T10:00:00.000Z',
      }),
    ],
  );

  @override
  Future<Paged<AgentStockTopup>> agentStockHistory({String? cursor}) async {
    stockLoads++;
    return Paged(
      items: [
        AgentStockTopup.fromJson({
          'id': 't1',
          'diamonds': 2000000,
          'stockAfter': 2500000,
          'createdAt': '2026-11-02T10:00:00.000Z',
        }),
      ],
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

void main() {
  testWidgets(
    'History shows sent transfers and stock top-ups in full numbers',
    (tester) async {
      final economy = _FakeEconomy();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionProvider.overrideWith(_AgentSession.new),
            meProvider.overrideWithValue(_agent()),
            economyRepo.overrideWithValue(economy),
          ],
          child: const MaterialApp(home: AgentRechargeScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Agent stock on the Recharge tab is the full number, never "2.5M".
      expect(find.text('2,500,000'), findsOneWidget);

      await tester.tap(find.text('History'));
      await tester.pumpAndSettle();
      expect(find.text('Sent to users'), findsOneWidget);
      expect(find.text('Stock received'), findsOneWidget);
      expect(find.text('💎 1,234,567'), findsOneWidget);
      expect(find.text('+💎 1,500,000'), findsOneWidget);
      expect(economy.stockLoads, 0);

      await tester.tap(find.text('Stock received'));
      await tester.pumpAndSettle();
      expect(economy.stockLoads, 1);
      expect(find.text('Stock top-up'), findsOneWidget);
      expect(find.text('+💎 2,000,000'), findsOneWidget);
      expect(find.textContaining('Stock after 💎 2,500,000'), findsOneWidget);
    },
  );
}
