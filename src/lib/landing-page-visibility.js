// Pure helpers for public landing-page visibility (publish_state).
// Single source of truth for the three states + the render/gate mapping.
// Consumed by the chooser render (src/app/welcome/page.js), the studio-page
// gate (src/app/welcome/[location]/page.js), the chooser-settings API schema,
// and the editor UI (ChooserEditorForm).

export const PUBLISH_STATES = ['live', 'coming_soon', 'hidden']

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
