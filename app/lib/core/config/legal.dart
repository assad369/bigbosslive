/// Mirrors `CURRENT_TERMS_VERSION` and `MIN_USER_AGE` in `packages/shared`
/// (`test/legal_contract_test.dart` checks them). The server refuses an older version.
const kTermsVersion = '2026-11-22';

/// Nobody younger may hold an account.
const kMinUserAge = 18;

/// Whole years between [birthday] and [now], by calendar date.
int ageOn(DateTime birthday, DateTime now) {
  var age = now.year - birthday.year;
  if (now.month < birthday.month ||
      (now.month == birthday.month && now.day < birthday.day)) {
    age--;
  }
  return age;
}
