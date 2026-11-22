import 'package:bigboss_live/core/network/api_exception.dart';
import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/profile/birthday_tile.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

MeUser _me({String? birthday}) => MeUser.fromJson({
  'id': 'u1',
  'shortId': '201',
  'displayName': 'New',
  'wallet': {'diamonds': 0},
  'levelProgress': {'level': 0},
  'birthday': birthday,
});

class _Session extends SessionController {
  @override
  Future<MeUser?> build() async => _me();
}

/// Records the date sent and answers like the server: under 18 is refused.
class _Account implements AccountRepository {
  DateTime? sent;

  @override
  Future<MeUser> setBirthday(DateTime birthday) async {
    sent = birthday;
    if (birthday.isAfter(DateTime(2008, 6, 1))) {
      throw const ApiException(403, 'underage', 'You must be 18 or older');
    }
    return _me(
      birthday:
          '${birthday.year}-${birthday.month.toString().padLeft(2, '0')}-'
          '${birthday.day.toString().padLeft(2, '0')}T00:00:00.000Z',
    );
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
    ],
  );
  addTearDown(container.dispose);
  await container.read(sessionProvider.future);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Scaffold(body: BirthdayTile(today: DateTime(2026, 6, 1))),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

Future<void> _pickYearAndSave(WidgetTester tester, String year) async {
  await tester.tap(find.byKey(const Key('profile-birthday')));
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
  await tester.tap(find.byKey(const Key('birthday-confirm')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('an adult date is saved once and then shown locked', (
    tester,
  ) async {
    final account = _Account();
    final container = await _pump(tester, account);
    expect(find.text('Add your date of birth'), findsOneWidget);

    await _pickYearAndSave(tester, '1990');
    expect(account.sent?.year, 1990);
    expect(container.read(sessionProvider).value?.birthday?.year, 1990);
    expect(find.text('Add your date of birth'), findsNothing);
    expect(find.byIcon(Icons.lock_outline), findsOneWidget);
  });

  testWidgets('an under-18 date ends in the underage refusal', (tester) async {
    final account = _Account();
    final container = await _pump(tester, account);
    await _pickYearAndSave(tester, '2015');
    expect(account.sent?.year, 2015);
    final err = container.read(sessionProvider).error;
    expect(err, isA<ApiException>());
    expect((err! as ApiException).code, 'underage');
  });
}
