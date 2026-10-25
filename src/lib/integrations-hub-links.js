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
