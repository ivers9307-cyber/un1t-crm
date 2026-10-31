// Pure helpers for public landing-page visibility (publish_state).
// Single source of truth for the tile states + the render/gate mapping.
// Consumed by the chooser render (src/app/welcome/page.js), the studio-page
// gate (src/app/welcome/[location]/page.js), the chooser-settings API schema,
// and the editor UI (ChooserEditorForm).

export const PUBLISH_STATES = ['live', 'coming_soon', 'hidden']

// PAGES.1 — the states a landing_pages row holds. The chooser tile keeps the
// three above (a tile is either shown, dimmed or not there at all); the page
// behind it has four. tileModeFor reads either vocabulary.
export const PAGE_PUBLISH_STATES = ['draft', 'live', 'coming_soon', 'retired']

// Map a publish_state to how its chooser tile should render.
// Unknown / null / off-list defaults to 'hidden' — fail closed so a
// misconfigured row never leaks as a live, clickable tile.
export function tileModeFor(state) {
  if (state === 'live') return 'active'
  if (state === 'coming_soon') return 'coming_soon'
  return 'hidden'
}

// True only when the page should be publicly reachable at its URL.
export function isPubliclyVisible(state) {
  return state === 'live'
}

// A tile's publish_state written onto its studio page: hidden is a draft.
export function tileStateToPageState(state) {
  if (state === 'live') return 'live'
  if (state === 'coming_soon') return 'coming_soon'
  return 'draft'
}

// A studio page's state as the chooser editor shows it: draft and retired are
// hidden (an unknown state fails closed, like tileModeFor).
export function pageStateToTileState(state) {
  if (state === 'live') return 'live'
  if (state === 'coming_soon') return 'coming_soon'
  return 'hidden'
}
