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
