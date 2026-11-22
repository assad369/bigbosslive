/**
 * Who operates BigBoss Live, as the legal pages (`/legal/*`, `/delete-account`) state it.
 *
 * FILL IN every `{{…}}` value before publishing the app: Google Play reviews these pages, and
 * the child-safety contact must be a real person who can act on a report. The server logs a
 * warning at startup while any placeholder is left (`unfilledOperatorFields`).
 *
 * Bump `effectiveDate` whenever a page changes materially, and bump `CURRENT_TERMS_VERSION`
 * in `packages/shared` too, so every user accepts the new version in the app.
 */
export const OPERATOR = {
  /** The name on the Play listing (Play matches the pages to the developer or app name). */
  name: 'Bigboss Live',
  appName: 'BigBoss Live',
  /** Country the operator is established in, e.g. "Bangladesh". */
  country: '{{OPERATOR_COUNTRY}}',
  /** Postal address for legal notices. */
  address: '{{OPERATOR_POSTAL_ADDRESS}}',
  supportEmail: '{{SUPPORT_EMAIL}}',
  privacyEmail: '{{PRIVACY_EMAIL}}',
  /** The person Google Play and the authorities contact about child safety (CSAE). */
  childSafetyContactName: '{{CHILD_SAFETY_CONTACT_NAME}}',
  childSafetyEmail: '{{CHILD_SAFETY_EMAIL}}',
  /** Courts and law that govern the Terms, e.g. "the laws of Bangladesh". */
  governingLaw: '{{GOVERNING_LAW}}',
  /** How long financial records (purchases, gifts, withdrawals) are kept, e.g. "6 years". */
  financialRetention: '{{FINANCIAL_RECORD_RETENTION}}',
  effectiveDate: '22 November 2026',
} as const;

/** Fields still holding a `{{…}}` placeholder. */
export function unfilledOperatorFields(): string[] {
  return Object.entries(OPERATOR)
    .filter(([, v]) => /\{\{[A-Z_]+\}\}/.test(v))
    .map(([k]) => k);
}
