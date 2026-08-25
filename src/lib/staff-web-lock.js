// STAFF-WEB-LOCK — staff browser lockout decision (app-only staff access).
//
// Product decision (Richard, 19 Aug 2026): once the Repset app is publicly
// released, staff should not work the CRM through a web browser at all —
// desktop included. An authenticated page request from a staff session gets
// bounced to /use-the-app, which offers the repset:// deep link and the
// store listings. The wall is UX enforcement, not a security boundary: the
// same person can still reach every /api/* route with their own Bearer
// token, because that is exactly what the app does.
//
//   - Gated behind STAFF_WEB_LOCK=1 (default OFF). Kill switch = unset the
//     var. Do not enable before the App Store listing is public — the wall
//     points people at store pages that would 404.
//   - On this host every resolved profile IS a staff role (master, owner,
//     manager, head_coach, staff, reception — there is no member web user),
//     so "staff in a browser" reduces to "any authenticated page request"
//     and no per-request profiles lookup is needed.
//   - Studio devices are exempt via the studio_session cookie: PIN tablets
//     and the Mac front-desk shell are browser surfaces BY DESIGN. TVs,
//     /present and /tv/cast are token-URL public paths that return from the
//     proxy's publicPaths check before the auth gate, so they never reach
//     this decision. The native studio iPad only calls /api/*.
//   - NEVER /api/* — the mobile app and every integration live there. In
//     the proxy's flow the API Bearer gate returns before the page session
//     gate, so /api/* should never reach this decision; the exemption here
//     is defense in depth.
//   - /live is a studio display surface (session-gated wall clock/heart-rate
//     views driven by gym hardware), not a staff workflow — exempt so a
//     signed-in display session keeps rendering.
//
// decideStaffWebLock() is pure so the decision table is unit tested
// (staff-web-lock.test.js); src/proxy.js supplies request facts + the env
// flag and mechanically applies the returned redirect. Edge-safe: no node
// builtins, no imports.

// The interstitial itself — must be listed in the proxy's publicPaths AND
// AppShell's PUBLIC_PATHS (CLAUDE.md: every public path needs both) or the
// wall would redirect-loop / render inside the app chrome.
export const STAFF_WEB_LOCK_PATH = '/use-the-app'

// Must equal COOKIE_NAME in src/lib/studio-session.js. Duplicated rather
// than imported because that module pulls node:crypto, which cannot ride
// into the edge bundle; staff-web-lock.test.js asserts the two stay equal.
export const STUDIO_SESSION_COOKIE = 'studio_session'

// Paths excluded by SEGMENT (exact match or a deeper segment beneath them),
// not raw prefix — same posture as legacy-host-redirect.js so e.g. a future
// '/use-the-appliance' page is not silently exempted.
const EXEMPT_PATHS = [
  STAFF_WEB_LOCK_PATH, // the wall page itself
  '/live',             // studio display surface (see header comment)
  '/login',            // defense in depth — all three are publicPaths and
  '/auth/callback',    // return from the proxy before the auth gate, but a
  '/reset-password',   // future publicPaths edit must not break sign-in/out
]

function isExemptPath(pathname) {
  if (pathname.startsWith('/api/')) return true
  return EXEMPT_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )
}

/**
 * Decide whether an authenticated page request should be walled off to the
 * "use the app" interstitial. Call only after the proxy has resolved a
 * Supabase user for a non-public path.
 *
 * @param {object}  args
 * @param {boolean} [args.enabled]          — STAFF_WEB_LOCK === '1'
 * @param {string}  args.pathname           — request.nextUrl.pathname
 * @param {boolean} [args.hasStudioSession] — studio_session cookie present
 * @returns {{ redirect: string } | null}
 */
export function decideStaffWebLock({ enabled, pathname, hasStudioSession }) {
  if (enabled !== true) return null
  if (hasStudioSession === true) return null
  if (isExemptPath(pathname)) return null
  return { redirect: STAFF_WEB_LOCK_PATH }
}
