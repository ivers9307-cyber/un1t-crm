// EVENTS-HUB.1 — pure routing for the mobile Events hub.
//
// One "Events" tile in the More grid nests the two event-side surfaces;
// it routes by access level (same flow as the Accounting / Reports hubs):
//
//   canOrders       — revenue ledger (race signups + car deposits)  (`orders`)
//   canRaceControl  — trackside race-day control panel              (`races`)
//
// 0 surfaces → null (the tile is access-gated so this shouldn't render)
// 1 surface  → that surface's key (go straight there)
// 2          → 'chooser' (show the picker)
// Pure — unit-tested in CI.

export function eventsLanding({ canOrders, canRaceControl } = {}) {
  const available = [
    canOrders ? 'orders' : null,
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
  orders: '/orders',
  races: '/races',
  chooser: '/events',
})
