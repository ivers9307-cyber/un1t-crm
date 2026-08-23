// HOME-LOC.4 — pure logic for the Home surface: the 7-day shift window,
// agenda grouping, and the on-site tile list. No native imports.
//
// Tile gates mirror the Studio hub EXACTLY (mobile/app/(staff)/(tabs)/studio.jsx):
// AC + doors on `studio_management`, timer on `class_timer`, TV on
// `tv_displays`, music + plugs on the ONE `device_control` key —
// deliberately the same resolution, not parallel checks that could drift.
// Icon/tint/subtitle strings are copied verbatim from that hub too, so the
// Home tile and the Studio hub tile for the same feature read identically.

import { isoDate, addDays, parseIsoDate, shortDate } from './dates'
import { canMobile } from './permissions'

export function shiftWindow(now = new Date()) {
  return { startDate: isoDate(now), endDate: isoDate(addDays(now, 6)) }
}

export function shiftTimeLabel(shift) {
  const start = (shift?.start_time_override || shift?.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift?.end_time_override || shift?.shift_templates?.end_time || '').slice(0, 5)
  if (start && end) return `${start}–${end}`
  return start || ''
}

/** Agenda groups for the next `days` days from todayIso; empty days dropped. */
export function groupShiftsByDay(shifts, todayIso, days = 7) {
  const start = parseIsoDate(todayIso)
  const out = []
  for (let i = 0; i < days; i++) {
    const iso = isoDate(addDays(start, i))
    const dayShifts = (shifts || []).filter((s) => s?.shift_date === iso)
    if (dayShifts.length === 0) continue
    dayShifts.sort((a, b) => shiftTimeLabel(a).localeCompare(shiftTimeLabel(b)))
    out.push({
      iso,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(addDays(start, i)),
      shifts: dayShifts,
    })
  }
  return out
}

// Order + copy deliberately match mobile/app/(staff)/(tabs)/studio.jsx's
// ChoiceCard list verbatim (icon, tint, title, subtitle) for the four
// tiles that already exist there — Home is a second entry point onto the
// same features, not a re-imagining of them.
const TILES = [
  { key: 'sonos',  href: '/sonos',  perm: 'device_control',    icon: 'musical-notes-outline', tint: '#F59E0B', title: 'Studio music',     subtitle: 'Play, pause, volume, favourites' },
  { key: 'shelly', href: '/shelly', perm: 'device_control',    icon: 'flash-outline',         tint: '#EC4899', title: 'Smart plugs',      subtitle: 'Switch an adopted Shelly relay on or off' },
  { key: 'ac',     href: '/ac',     perm: 'studio_management', icon: 'snow-outline',          tint: '#2563EB', title: 'Air conditioning', subtitle: 'Sensibo gym floor + LG ThinQ units' },
  { key: 'doors',  href: '/doors',  perm: 'studio_management', icon: 'key-outline',           tint: '#A855F7', title: 'Door unlock',      subtitle: 'UniFi Access doors' },
  { key: 'timer',  href: '/timer',  perm: 'class_timer',       icon: 'stopwatch-outline',     tint: '#10B981', title: 'Class timer',      subtitle: 'Run a Myzone-style interval timer on the TV' },
  { key: 'tv',     href: '/tv',     perm: 'tv_displays',       icon: 'tv-outline',            tint: '#0EA5E9', title: 'TV displays',      subtitle: "What's on the studio TVs — view & clear" },
]

export function homeTiles(profile, location) {
  if (!profile || !location) return []
  return TILES.filter((t) => canMobile(profile, t.perm, location))
}
