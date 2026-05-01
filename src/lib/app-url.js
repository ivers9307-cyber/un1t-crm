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
      '(e.g. https://crm.un1tdublin.com in production, http://localhost:3000 in dev).'
    )
  }
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
