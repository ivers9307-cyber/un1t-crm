/**
 * Returns NEXT_PUBLIC_APP_URL with no silent fallback.
 *
 * Use this in code paths that need to build absolute URLs (e.g. unsubscribe
 * links embedded in outbound emails) and have no incoming request to derive
 * the host from. Throws a clear error if the env var isn't set so a
 * misconfiguration surfaces immediately instead of silently sending users to
 * a stale domain.
 *
 * For inbound requests (e.g. redirect handlers), prefer
 * `new URL(request.url).origin` — that always matches the host the user
 * actually typed, so it can't drift out of sync with DNS.
 *
 * @returns {string} Configured base URL, no trailing slash.
 */
export function getAppUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL
  if (!raw) {
    throw new Error(
      'NEXT_PUBLIC_APP_URL is not set. Configure it in your environment ' +
      '(e.g. https://crm.repset.ie in production, http://localhost:3000 in dev).'
    )
  }
  return raw.replace(/\/+$/, '')
}

/**
 * The member-app (champ) origin used when `NEXT_PUBLIC_CHAMP_APP_URL` is
 * unset. Exported so tests and call sites name the same constant instead of
 * re-typing the literal — it was copied into three files and they drifted.
 */
export const MEMBER_APP_DEFAULT_ORIGIN = 'https://api.repset.ie'

/**
 * Returns the base URL of the MEMBER app (champ-app) — a DIFFERENT
 * deployment to this one. Member-facing deep links (`/sessions/<id>`,
 * `/auth/callback`) live there; this repo's own host has no such routes, and
 * building them on `getAppUrl()` is what 404'd every post-class-email CTA in
 * prod (#1444).
 *
 * WHY THIS ONE DOES NOT THROW, unlike `getAppUrl()`:
 *   `NEXT_PUBLIC_APP_URL` is THIS deployment's own host — the CRM can always
 *   know it, and a missing value is a misconfiguration we want to hear about
 *   immediately. The member app's host belongs to another service, is not
 *   currently set on this deployment (REPSET-P6.S2 flipped the *code default*
 *   to the repset host precisely because nothing sets the env), and the only
 *   consumer on the send path is a customer email. Throwing there would
 *   delete the email AND leave `heart_rate_sessions.email_sent_at` unstamped,
 *   so the auto-end sweep re-selects the row and re-pushes every 5 minutes —
 *   the exact loop `markProcessed` exists to stop. Per CLAUDE.md's
 *   "removing a silent failure must never create a louder one", losing a
 *   customer message is worse than a documented, single-sourced default.
 *
 * Set `NEXT_PUBLIC_CHAMP_APP_URL` on the deployment and this follows it; once
 * it is set everywhere, this can become a throwing accessor like `getAppUrl`.
 *
 * @returns {string} no trailing slash
 */
export function getMemberAppUrl() {
  const raw = process.env.NEXT_PUBLIC_CHAMP_APP_URL || MEMBER_APP_DEFAULT_ORIGIN
  return raw.replace(/\/+$/, '')
}

/**
 * Returns the origin of the incoming request — protocol + host, no trailing
 * slash. Use for redirect handlers and any other code that wants the URL
 * the user actually typed (so the redirect can never go to the wrong domain).
 *
 * @param {Request} request
 * @returns {string}
 */
export function getRequestOrigin(request) {
  return new URL(request.url).origin
}

/**
 * Returns the base URL to use when generating BUYER-FACING deposit links —
 * the public car-deposit pages. Distinct from the CRM origin so we can host
 * payment pages on a dedicated brand-appropriate domain (e.g.
 * pay.ccfautos.com) while the operator app stays on crm.un1tdublin.com.
 *
 * Resolution order:
 *   1. DEPOSIT_BASE_URL env var (production: the dedicated payment domain)
 *   2. NEXT_PUBLIC_APP_URL fallback (so a misconfigured deploy still works)
 *
 * Throws if neither is set so a misconfigured deploy fails loudly.
 *
 * @returns {string} no trailing slash
 */
export function getDepositBaseUrl() {
  const raw = process.env.DEPOSIT_BASE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (!raw) {
    throw new Error(
      'No deposit base URL configured. Set DEPOSIT_BASE_URL (preferred — e.g. ' +
      'https://pay.ccfautos.com) or NEXT_PUBLIC_APP_URL.'
    )
  }
  return raw.replace(/\/+$/, '')
}

/**
 * Returns the base URL for BCA-recipient-facing pages — the per-
 * submission re-download page at /bca/<token>. Distinct from the
 * deposit base so the operator can serve BCA links on a different
 * (or apex) CCFA-branded domain (e.g. https://ccfautos.com) without
 * coupling it to the payment subdomain.
 *
 * Resolution order:
 *   1. BCA_BASE_URL env var (production: dedicated BCA domain)
 *   2. DEPOSIT_BASE_URL fallback (already CCFA-branded — sensible default)
 *   3. NEXT_PUBLIC_APP_URL final fallback (CRM host)
 *
 * Throws if none are set so a misconfigured deploy fails loudly.
 *
 * @returns {string} no trailing slash
 */
export function getBcaBaseUrl() {
  const raw =
    process.env.BCA_BASE_URL ||
    process.env.DEPOSIT_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL
  if (!raw) {
    throw new Error(
      'No BCA base URL configured. Set BCA_BASE_URL (preferred — e.g. ' +
      'https://ccfautos.com), or DEPOSIT_BASE_URL, or NEXT_PUBLIC_APP_URL.'
    )
  }
  return raw.replace(/\/+$/, '')
}
