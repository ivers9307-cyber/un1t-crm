// REPSET-ACCOUNT.2 — the ONE set-active-location path.
//
// The web location switcher (src/components/LocationSwitcher.jsx) sets
// the active studio by writing the `un1t_active_location` cookie that
// getCurrentUser() reads server-side (src/lib/auth.js — priority 2,
// validated against the caller's own assignments). This module factors
// that exact write out so the Account Home "Open studio →" reuses the
// identical mechanism instead of hand-rolling a second one.
//
// SECURITY: the cookie value is validated in getCurrentUser against the
// user's actual location assignments — a value pointing at a studio the
// caller cannot access is silently ignored and the next priority wins.
// So writing this cookie can only ever activate a studio the caller
// already has access to; the portfolio/account-nav only lists those.

export const ACTIVE_LOCATION_COOKIE = 'un1t_active_location'

// 1 year, matching the switcher's original max-age.
const ACTIVE_LOCATION_MAX_AGE = 365 * 24 * 60 * 60

/**
 * The exact document.cookie value the location switcher writes. Pure —
 * unit-tested so the format can't silently drift between the switcher
 * and the Account Home. `document.cookie = activeLocationCookieValue(id)`
 * IS the write.
 *
 * @param {string} locationId
 * @returns {string}
 */
export function activeLocationCookieValue(locationId) {
  return `${ACTIVE_LOCATION_COOKIE}=${locationId}; path=/; max-age=${ACTIVE_LOCATION_MAX_AGE}; SameSite=Lax`
}

/**
 * Set the active studio in the browser — the switcher's mechanism.
 * Client-only (writes document.cookie); a no-op in a non-DOM context so
 * it's safe to import into a server-rendered module tree. Callers still
 * navigate/refresh afterwards to pick the new context up server-side.
 *
 * @param {string} locationId
 */
export function setActiveLocation(locationId) {
  if (typeof document === 'undefined') return
  document.cookie = activeLocationCookieValue(locationId)
}
