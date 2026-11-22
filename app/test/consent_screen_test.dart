import 'package:bigboss_live/core/network/api_exception.dart';
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

/// Records the consent call and answers like the server: under 18 is refused.
class _Account implements AccountRepository {
  DateTime? sent;

  @override
  Future<MeUser> consent({DateTime? birthday}) async {
    sent = birthday;
    if (birthday != null && birthday.isAfter(DateTime(2008, 6, 1))) {
      throw const ApiException(403, 'underage', 'You must be 18 or older');
    }
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
      child: MaterialApp(home: ConsentScreen(today: DateTime(2026, 6, 1))),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

Future<void> _pickYear(WidgetTester tester, String year) async {
  await tester.tap(find.byKey(const Key('consent-birthday')));
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(
    find.text(year),
    -200,
    scrollable: find.descendant(
      of: find.byType(YearPicker),
      matching: find.byType(Scrollable),
    ),
  );
  await tester.ensureVisible(find.text(year));
  await tester.pumpAndSettle();
  await tester.tap(find.text(year));
  await tester.pumpAndSettle();
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
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
  testWidgets('Continue needs a date of birth and the box ticked', (
    tester,
  ) async {
    final account = _Account();
    final container = await _pump(tester, account);
    expect(_continueEnabled(tester), isFalse);

    await tester.tap(_agreeBox);
    await tester.pump();
    expect(_continueEnabled(tester), isFalse, reason: 'no date of birth yet');

    await _pickYear(tester, '1990');
    expect(_continueEnabled(tester), isTrue);

    await tester.tap(find.byKey(const Key('consent-continue')));
    await tester.pumpAndSettle();
    expect(account.sent?.year, 1990);
    expect(container.read(sessionProvider).value?.needsConsent, isFalse);
  });

  testWidgets('an under-18 date ends in the underage refusal', (tester) async {
    final account = _Account();
    final container = await _pump(tester, account);
    await tester.tap(_agreeBox);
    await _pickYear(tester, '2015');
    await tester.tap(find.byKey(const Key('consent-continue')));
    await tester.pumpAndSettle();
    expect(account.sent?.year, 2015);
    final err = container.read(sessionProvider).error;
    expect(err, isA<ApiException>());
    expect((err! as ApiException).code, 'underage');
  });
}
