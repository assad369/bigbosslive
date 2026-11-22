import { CURRENT_TERMS_VERSION, MIN_USER_AGE } from '@bigboss/shared';
import type { UserDoc } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';

/** Whole years between a date of birth and `now`, by UTC calendar date. Pure. */
export function ageOn(birthday: Date, now: Date): number {
  let age = now.getUTCFullYear() - birthday.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birthday.getUTCMonth() ||
    (now.getUTCMonth() === birthday.getUTCMonth() && now.getUTCDate() < birthday.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

/** A plausible date of birth: not in the future and not more than 120 years ago. */
export function plausibleBirthday(birthday: Date, now: Date): boolean {
  return birthday.getTime() <= now.getTime() && ageOn(birthday, now) <= 120;
}

export const underage = () =>
  new AppError(403, 'underage', `You must be ${MIN_USER_AGE} or older to use BigBoss Live`);

/** Throws `underage` for a date of birth under `MIN_USER_AGE`, 400 for an implausible one. */
export function assertAdultBirthday(birthday: Date, now: Date): void {
  if (!plausibleBirthday(birthday, now))
    throw new AppError(400, 'invalid_birthday', 'Enter a valid date of birth');
  if (ageOn(birthday, now) < MIN_USER_AGE) throw underage();
}

/**
 * The app shows the consent screen (the current Terms) until this is false. The date of birth
 * is not part of it: it is given from Edit profile, and `assertAdultUser` gates what needs it.
 */
export const needsConsent = (u: Pick<UserDoc, 'termsAcceptedVersion'>): boolean =>
  u.termsAcceptedVersion !== CURRENT_TERMS_VERSION;

/**
 * Money features with real-world value (games, withdrawals) need a stated adult date of birth.
 * 403 `age_required` until the user has given one.
 */
export function assertAdultUser(u: Pick<UserDoc, 'birthday' | 'underageAt'>, now: Date): void {
  if (u.underageAt) throw underage();
  if (!u.birthday)
    throw new AppError(403, 'age_required', 'Add your date of birth in Edit profile first');
  if (ageOn(u.birthday, now) < MIN_USER_AGE) throw underage();
}
