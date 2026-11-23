import { CURRENT_TERMS_VERSION } from '@bigboss/shared';
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

export const invalidBirthday = () =>
  new AppError(400, 'invalid_birthday', 'Enter a valid date of birth');

/**
 * The app shows the consent screen (the current Terms) until this is false. The date of birth
 * is not part of it: it is an optional profile field and gates nothing.
 */
export const needsConsent = (u: Pick<UserDoc, 'termsAcceptedVersion'>): boolean =>
  u.termsAcceptedVersion !== CURRENT_TERMS_VERSION;
