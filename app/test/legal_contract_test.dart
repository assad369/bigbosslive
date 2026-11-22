import 'dart:io';

import 'package:bigboss_live/core/config/legal.dart';
import 'package:bigboss_live/features/profile/profile_screens.dart';
import 'package:flutter_test/flutter_test.dart';

final _shared = File('../packages/shared/src/constants.ts').readAsStringSync();

String _const(String name) =>
    RegExp('export const $name = ([^;]+);').firstMatch(_shared)![1]!.trim();

List<String> _list(String name) {
  final start = _shared.indexOf('export const $name');
  final block = _shared.substring(start, _shared.indexOf('] as const;', start));
  return RegExp(r"'([a-z_]+)'").allMatches(block).map((m) => m[1]!).toList();
}

void main() {
  test('the terms version and minimum age match packages/shared', () {
    expect(_const('CURRENT_TERMS_VERSION'), "'$kTermsVersion'");
    expect(_const('MIN_USER_AGE'), '$kMinUserAge');
  });

  test('every report reason is one the server accepts, child safety first', () {
    expect(_list('REPORT_REASONS'), containsAll(reportReasons.keys));
    expect(reportReasons.keys.first, 'child_safety');
  });

  test('ageOn counts whole years by calendar date', () {
    final born = DateTime(2008, 6, 15);
    expect(ageOn(born, DateTime(2026, 6, 14)), 17);
    expect(ageOn(born, DateTime(2026, 6, 15)), 18);
    expect(ageOn(DateTime(2008, 2, 29), DateTime(2026, 2, 28)), 17);
  });
}
