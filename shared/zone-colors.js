// Afterglow dark-canvas zone palette (spec 2026-08-01). Same 5-step semantic
// as ZONE_DEFS — these are the zone colours RETUNED for the iron #0F1216
// canvas (mobile surfaces). ZONE_DEFS.color stays canonical for web, the
// share card, and anything on light surfaces. A view, never a mutation.
export const ZONE_COLORS_DARK = {
  1: '#A3ABB6', // Ash (Warm-up)
  2: '#4D9FFF', // Glacier (Easy)
  3: '#22C58B', // Field (Aerobic)
  4: '#FFA928', // Furnace (Threshold — also the Burn colour)
  5: '#FF4E42', // Redline (Max)
}

export function zoneColorDark(id) {
  return ZONE_COLORS_DARK[Number(id)] ?? null
}
