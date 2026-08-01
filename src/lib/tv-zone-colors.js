// Afterglow dark-canvas zone palette for the public TV boards (GRAFT-TV
// 2026-08). Mirrors champ-app shared/zone-colors.js — the two must stay in
// sync by hand. The canonical ZONE_DEFS in src/lib/heart-rate.js stays
// untouched: its colours serve light surfaces and the zone science
// (thresholds, points). This module is a VIEW for dark boards (iron #0F1216
// canvas), never a mutation of the model.

export const ZONE_COLORS_DARK = {
  1: '#A3ABB6', // Ash (Warm-up)
  2: '#4D9FFF', // Glacier (Easy)
  3: '#22C58B', // Field (Aerobic)
  4: '#FFA928', // Furnace (Threshold — also the Burn colour)
  5: '#FF4E42', // Redline (Max)
}

// Iron washed toward each zone — the tile background tints. Kept as flat
// hexes (not rgba over #0F1216) so tiles composite predictably on any layer.
export const ZONE_WASH_DARK = {
  1: '#252A31',
  2: '#1B2B3E',
  3: '#17312C',
  4: '#332C21',
  5: '#332225',
}

/**
 * Dark-canvas colour for a zone id. Tolerant of string ids ('3') via
 * Number(); null for anything outside 1..5.
 */
export function zoneColorDark(id) {
  return ZONE_COLORS_DARK[Number(id)] ?? null
}

/**
 * The room's dominant zone — powers the board's dominant-zone glow.
 *
 * Given the board's live session list (each session carrying a flat `zoneId`
 * or a nested `currentZone.id`), returns the most common zone id among live
 * members. Ties resolve to the HIGHER zone (the board runs hot when the room
 * is split). Sessions with no recognisable zone id are skipped; returns null
 * when nothing qualifies (empty room, no straps yet).
 *
 * @param {Array<{ zoneId?: number|string, currentZone?: { id?: number|string } }>} sessions
 * @returns {number|null}
 */
export function dominantZone(sessions) {
  const counts = {}
  for (const s of sessions || []) {
    const id = Number(s?.zoneId ?? s?.currentZone?.id)
    if (!ZONE_COLORS_DARK[id]) continue
    counts[id] = (counts[id] || 0) + 1
  }
  let best = null
  for (let z = 1; z <= 5; z++) {
    if (!counts[z]) continue
    if (best === null || counts[z] >= counts[best]) best = z // >= : tie -> higher zone
  }
  return best
}
