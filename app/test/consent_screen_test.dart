import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/legal/consent_screen.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

MeUser _me({bool needsConsent = true}) => MeUser.fromJson({
  'id': 'u1',
  'shortId': '201',
  'displayName': 'New',
  'wallet': {'diamonds': 0},
  'levelProgress': {'level': 0},
  'needsConsent': needsConsent,
});

class _Session extends SessionController {
  @override
  Future<MeUser?> build() async => _me();
}

/// Records the consent call.
class _Account implements AccountRepository {
  int calls = 0;

  @override
  Future<MeUser> consent() async {
    calls++;
    return _me(needsConsent: false);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Future<ProviderContainer> _pump(WidgetTester tester, _Account account) async {
  final container = ProviderContainer(
    overrides: [
      sessionProvider.overrideWith(_Session.new),
      accountRepo.overrideWithValue(account),
      appConfigProvider.overrideWith(
        (ref) async => AppConfig.fromJson({
          'app': {'minSupportedBuild': <String, Object?>{}},
        }),
      ),
    ],
  );
  addTearDown(container.dispose);
  await container.read(sessionProvider.future);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: ConsentScreen()),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

/// The box itself: the row's text holds the Terms / Guidelines / Privacy links.
final _agreeBox = find.descendant(
  of: find.byKey(const Key('consent-agree')),
  matching: find.byType(Checkbox),
);

bool _continueEnabled(WidgetTester tester) => tester
    .widget<FilledButton>(find.byKey(const Key('consent-continue')))
    .enabled;

void main() {
  testWidgets('Continue needs only the box ticked, no date of birth', (
    tester,
  ) async {
    final account = _Account();
    final container = await _pump(tester, account);
    expect(find.byIcon(Icons.cake_outlined), findsNothing);
    expect(_continueEnabled(tester), isFalse);

    await tester.tap(_agreeBox);
    await tester.pump();
    expect(_continueEnabled(tester), isTrue);

    await tester.tap(find.byKey(const Key('consent-continue')));
    await tester.pumpAndSettle();
    expect(account.calls, 1);
    expect(container.read(sessionProvider).value?.needsConsent, isFalse);
  });
}
