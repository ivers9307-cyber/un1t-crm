// EVENTS-HUB.1 — pure routing for the mobile Events hub.
//
// One "Events" tile in the More grid nests the event-side surfaces; it
// routes by access level (same flow as the Accounting / Reports hubs):
//
//   canRaceControl  — trackside race-day control panel  (`races`)
//
// EVENTS-HUB.2 (2026-06-13): Orders moved OUT of here and under
// Accounting — it's revenue, which belongs with the money surfaces. So
// today Events nests only Race control; it's kept as a hub (rather than
// folded back into a bare Race-control tile) because web + mobile event
// surfaces will be aligned here in the future and more will land under it.
//
// 0 surfaces → null (the tile is access-gated so this shouldn't render)
// 1 surface  → that surface's key (go straight there)
// 2+         → 'chooser' (show the picker)
// Pure — unit-tested in CI.

export function eventsLanding({ canRaceControl } = {}) {
  const available = [
    canRaceControl ? 'races' : null,
  ].filter(Boolean)
  if (available.length === 0) return null
  if (available.length === 1) return available[0]
  return 'chooser'
}

// Landing key → route. The single-surface keys reuse the exact routes
// the old standalone tiles pushed, so the destination screens are
// untouched; 'chooser' opens the hub itself.
export const EVENTS_ROUTES = Object.freeze({
  races: '/races',
  chooser: '/events',
})
