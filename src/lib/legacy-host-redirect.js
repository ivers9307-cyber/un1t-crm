// REPSET-P6.S2 — legacy-host → canonical-host redirect decision.
//
// Once repset.ie is the canonical domain, requests still arriving on the
// old CRM hostname (crm.un1tdublin.com) can be 308'd across so bookmarks,
// emailed links and search results converge on the new host. The redirect
// is a SAFETY VALVE, not always-on behaviour:
//
//   - Gated behind REDIRECT_LEGACY_CRM_HOST=1 (default OFF). Flip the env
//     var to enable; unset/anything-else keeps the legacy host serving
//     everything exactly as before. Kill switch = unset the var.
//   - ONLY the exact legacy CRM host. The marketing site (un1tdublin.com),
//     tenant brand hosts (pay.ccfautos.com, DB-tier tenant domains) and the
//     canonical host itself must never match.
//   - ONLY GET/HEAD. Mutating requests (forms mid-flight, mobile POSTs from
//     stale bundles) keep working on the legacy host rather than gambling
//     on every client's 308 body-replay behaviour.
//   - NEVER /api/* — kiosk heartbeats, bridge/fleet agents, webhooks and
//     mobile clients pin absolute URLs; bouncing them adds a failure mode
//     for zero canonicalisation win (nothing user-visible in the URL bar).
//   - NEVER /auth/callback or /reset-password — in-flight PKCE links carry
//     the code verifier in a cookie scoped to the OLD domain; hopping hosts
//     mid-exchange strands the verifier and the link dies (the estate's
//     known reset-PKCE failure class, see docs/LESSONS.md).
//   - NEVER /.well-known/ (AUDIT-13.D) — domain-verification files must be
//     served BY the domain being verified. public/.well-known/apple-
//     developer-merchantid-domain-association is Apple Pay's proof for the
//     embedded Stripe flow, and Apple re-fetches it (registration, renewal,
//     re-verification), anonymously, on whatever domain Stripe holds. A 308
//     across hosts is not a valid answer to that fetch, so flipping the flag
//     would fail Apple Pay verification for the legacy domain and the button
//     would stop appearing in Safari. The proxy's publicPaths and brands.js
//     FRAMEWORK_ASSET_PATHS both already carve this path out on every other
//     host tier; this module was the one that did not. (The eventual cleanup
//     is deregistering crm.un1tdublin.com in Stripe — until someone has done
//     that and confirmed it, the exclusion is what keeps the flag safe to
//     flip.)
//
// decideLegacyHostRedirect() is pure so the whole decision table is unit
// tested (legacy-host-redirect.test.js); src/proxy.js supplies request
// facts + the env flag and mechanically applies the returned redirect.
// Edge-safe: no node builtins, no imports.

export const LEGACY_CRM_HOST = 'crm.un1tdublin.com'
export const CANONICAL_CRM_ORIGIN = 'https://crm.repset.ie'

// Paths excluded by SEGMENT (exact match or a deeper segment beneath them),
// not raw prefix — '/reset-password-info' must not be swallowed. The same
// shape covers '/.well-known' → '/.well-known/<file>' without swallowing a
// hypothetical '/.well-known-archive'.
const EXCLUDED_PATHS = ['/auth/callback', '/reset-password', '/.well-known']

function isExcludedPath(pathname) {
  if (pathname.startsWith('/api/')) return true
  return EXCLUDED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )
}

/**
 * Decide whether a request on the legacy CRM host should be permanently
 * redirected to the canonical repset host.
 *
 * @param {object} args
 * @param {boolean} [args.enabled]  — REDIRECT_LEGACY_CRM_HOST === '1'
 * @param {string}  [args.host]     — raw Host header (may carry :port)
 * @param {string}  args.method     — HTTP method
 * @param {string}  args.pathname   — request.nextUrl.pathname
 * @param {string}  [args.search]   — request.nextUrl.search ('' or '?…')
 * @returns {{ status: 308, location: string } | null}
 */
export function decideLegacyHostRedirect({ enabled, host, method, pathname, search }) {
  if (enabled !== true) return null

  const bareHost = String(host || '').toLowerCase().split(':')[0]
  if (bareHost !== LEGACY_CRM_HOST) return null

  if (method !== 'GET' && method !== 'HEAD') return null

  if (isExcludedPath(pathname)) return null

  return {
    status: 308,
    location: `${CANONICAL_CRM_ORIGIN}${pathname}${search || ''}`,
  }
}
