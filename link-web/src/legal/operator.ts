/**
 * Who operates BigBoss Live, as the legal pages (`/legal/*`, `/delete-account`) state it.
 *
 * Google Play reviews these pages, and the child-safety email must reach a real person who can
 * act on a report. The server logs a warning at startup while any `{{…}}` placeholder is left
 * (`unfilledOperatorFields`). `address` and `childSafetyContactName` are optional: an empty
 * string leaves them out of the pages.
 *
 * Bump `effectiveDate` whenever a page changes materially, and bump `CURRENT_TERMS_VERSION`
 * in `packages/shared` too, so every user accepts the new version in the app.
 */
export interface Operator {
  /** The developer name on the Play listing (Play matches the pages to it). */
  readonly name: string;
  readonly appName: string;
  /** Country the operator is established in. */
  readonly country: string;
  /** Postal address for legal notices. Empty: not shown. */
  readonly address: string;
  readonly supportEmail: string;
  readonly privacyEmail: string;
  /** The person Google Play and the authorities contact about child safety (CSAE). Empty: not named on the page. */
  readonly childSafetyContactName: string;
  readonly childSafetyEmail: string;
  /** Completes "These Terms are governed by …". */
  readonly governingLaw: string;
  /** How long financial records (purchases, gifts, game transactions, withdrawals) are kept. */
  readonly financialRetention: string;
  readonly effectiveDate: string;
}

const CONTACT_EMAIL = 'developerasad46@gmail.com';

export const OPERATOR: Operator = {
  name: 'Bigboss Live',
  appName: 'BigBoss Live',
  country: 'Bangladesh',
  address: '',
  supportEmail: CONTACT_EMAIL,
  privacyEmail: CONTACT_EMAIL,
  childSafetyContactName: '',
  childSafetyEmail: CONTACT_EMAIL,
  governingLaw: 'the laws of Bangladesh',
  financialRetention: '6 years',
  effectiveDate: '22 November 2026',
};

/** "Bigboss Live (<address>, Bangladesh)", or "Bigboss Live, based in Bangladesh" without one. */
export function operatorIdentity(): string {
  const { name, address, country } = OPERATOR;
  return address ? `${name} (${address}, ${country})` : `${name}, based in ${country}`;
}

/** Fields still holding a `{{…}}` placeholder. */
export function unfilledOperatorFields(): string[] {
  return Object.entries(OPERATOR)
    .filter(([, v]) => /\{\{[A-Z_]+\}\}/.test(v))
    .map(([k]) => k);
}
