// INTEGONE.1 — the Integrations hub's own URLs, as a pure module both halves
// of the app can import (src/lib/integrations-hub.js pulls server-side libs
// and cannot enter a client bundle; it re-exports these).
//
// The hub is the only integrations surface: every card's Manage drawer is a
// URL, /settings/integrations-hub?manage=<cardKey>&location=<id>, which the
// hub reads on load and opens. It replaced the deep link into the
// per-location Integrations tab (/settings/locations/<id>?tab=<key>).

export const HUB_PATH = '/settings/integrations-hub'

/** The hub URL that opens `cardKey`'s Manage drawer for one location. Pure. */
export function hubManageHref(locationId, cardKey) {
  const q = new URLSearchParams({ manage: cardKey, location: locationId })
  return `${HUB_PATH}?${q.toString()}`
}

/** Legacy per-location tab key → hub card key (every other key is the same). */
export const HUB_CARD_FOR_TAB_KEY = Object.freeze({ 'ac-devices': 'climate' })

/**
 * INTEGONE.1 — where a URL of the retired per-location Integrations tab
 * (/settings/locations/<id>?section=integrations[&tab=<key>]) now lands: the
 * hub with that provider's Manage drawer open when the URL named one (the
 * legacy key mapped through HUB_CARD_FOR_TAB_KEY), else the bare hub (a
 * `location` alone opens nothing). Every other query param is carried across,
 * so the Stripe Connect return (`stripe=return`) and the Xero callback's
 * outcome codes (`xero_connected`, `xero_error`, …) reach the hub page that
 * reads them; a `manage`/`location` already on the URL is replaced, never
 * doubled. Pure.
 *
 * @param {string} locationId
 * @param {Record<string, string|string[]|undefined>} [searchParams]  a Next page's resolved searchParams
 */
export function legacyIntegrationsTabRedirect(locationId, searchParams = {}) {
  const rawTab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  const base = rawTab
    ? hubManageHref(locationId, HUB_CARD_FOR_TAB_KEY[rawTab] ?? rawTab)
    : `${HUB_PATH}?${new URLSearchParams({ location: locationId }).toString()}`
  const rest = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams || {})) {
    if (k === 'section' || k === 'tab' || k === 'manage' || k === 'location') continue
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one !== undefined && one !== null) rest.append(k, String(one))
    }
  }
  const tail = rest.toString()
  return tail ? `${base}&${tail}` : base
}
