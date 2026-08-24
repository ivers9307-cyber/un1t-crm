// HOME-LOC.4 — pure logic for the Home surface: the 7-day shift window,
// agenda grouping, and the on-site tile list. No native imports.
//
// Tile gates mirror the Studio hub EXACTLY (mobile/app/(staff)/(tabs)/studio.jsx):
// AC + doors on `studio_management`, timer on `class_timer`, TV on
// `tv_displays`, music + plugs on the ONE `device_control` key —
// deliberately the same resolution, not parallel checks that could drift.
// Icon/tint/subtitle strings are copied verbatim from that hub too, so the
// Home tile and the Studio hub tile for the same feature read identically.
// TILES order does NOT follow the hub, though — it follows plan §3
// (music first). TODO(HOME-LOC): when studio.jsx is next touched, have the
// hub import and render this array instead of keeping its own ChoiceCard
// list, so the two can't drift apart again.

import { isoDate, addDays, parseIsoDate, shortDate, timeRange } from './dates'
import { canMobile } from './permissions'
import { effShiftStart, effShiftEnd } from './schedule-team'

export function shiftWindow(now = new Date()) {
  return { startDate: isoDate(now), endDate: isoDate(addDays(now, 6)) }
}

// HOME-LOC.4b — built from schedule-team.js's effShiftStart/effShiftEnd (the
// SAME override → legacy-row → template resolution schedule.jsx's own cards
// use — not a parallel copy that could drift), rendered through dates.js's
// timeRange() so Home matches PersonalDashboard/schedule.jsx's spaced
// en-dash convention ('06:00 – 14:00'). timeRange(start, end) renders
// ' – ' for two empty strings and 'start – ' for a start with no end, so
// both cases are guarded explicitly rather than exposing that raw output.
export function shiftTimeLabel(shift) {
  const start = effShiftStart(shift)
  const end = effShiftEnd(shift)
  if (!start && !end) return ''
  if (!end) return start.slice(0, 5)
  if (!start) return end.slice(0, 5)
  return timeRange(start, end)
}

/** Agenda groups for the next `days` days from todayIso; empty days dropped. */
export function groupShiftsByDay(shifts, todayIso, days = 7) {
  const start = parseIsoDate(todayIso)
  // Explicit intent, not a lean on epoch arithmetic: a malformed/missing
  // todayIso has no window to build, full stop.
  if (!start) return []
  const out = []
  for (let i = 0; i < days; i++) {
    const iso = isoDate(addDays(start, i))
    const dayShifts = (shifts || []).filter((s) => s?.shift_date === iso)
    if (dayShifts.length === 0) continue
    // Sort key matches schedule.jsx's own Team-view sort (effShiftStart,
    // untimed-first via the '' fallback) rather than the rendered label.
    dayShifts.sort((a, b) => (effShiftStart(a) || '').localeCompare(effShiftStart(b) || ''))
    out.push({
      iso,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(addDays(start, i)),
      shifts: dayShifts,
    })
  }
  return out
}

// Order + copy: icon/tint/title/subtitle deliberately match
// mobile/app/(staff)/(tabs)/studio.jsx's ChoiceCard list verbatim for the
// four tiles that already exist there — Home is a second entry point onto
// the same features, not a re-imagining of them. The ORDER here follows
// plan §3 (music first), not the hub's AC-first order.
// `locAware: true` marks a tile whose destination screen actually READS the
// ?loc= route param (control-location.js's override tier) rather than
// binding straight to activeLocation. The manual controls launcher
// (HOME-LOC.9b) filters to these — forwarding ?loc= to a screen that
// ignores it is a false affordance: the header names one studio, the
// screen commands another. Timer/TV are not yet loc-aware (follow-up).
const TILES = [
  { key: 'sonos',  href: '/sonos',  perm: 'device_control',    icon: 'musical-notes-outline', tint: '#F59E0B', title: 'Studio music',     subtitle: 'Play, pause, volume, favourites', locAware: true },
  { key: 'shelly', href: '/shelly', perm: 'device_control',    icon: 'flash-outline',         tint: '#EC4899', title: 'Smart plugs',      subtitle: 'Switch an adopted Shelly relay on or off', locAware: true },
  { key: 'ac',     href: '/ac',     perm: 'studio_management', icon: 'snow-outline',          tint: '#2563EB', title: 'Air conditioning', subtitle: 'Sensibo gym floor + LG ThinQ units', locAware: true },
  { key: 'doors',  href: '/doors',  perm: 'studio_management', icon: 'key-outline',           tint: '#A855F7', title: 'Door unlock',      subtitle: 'UniFi Access doors', locAware: true },
  { key: 'timer',  href: '/timer',  perm: 'class_timer',       icon: 'stopwatch-outline',     tint: '#10B981', title: 'Class timer',      subtitle: 'Run a Myzone-style interval timer on the TV' },
  { key: 'tv',     href: '/tv',     perm: 'tv_displays',       icon: 'tv-outline',            tint: '#0EA5E9', title: 'TV displays',      subtitle: "What's on the studio TVs — view & clear" },
]

export function homeTiles(profile, location) {
  if (!profile || !location) return []
  return TILES.filter((t) => canMobile(profile, t.perm, location))
}
