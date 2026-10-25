// MIA-REVIEW.3 — the agent's ONE class-time formatter.
//
// Lived in booking-tools.js, which statically imports @/lib/glofox — so
// account-tools.js (deliberately test-loadable without the Next runtime)
// could not reuse it and kept handing the model a raw UTC ISO string. That
// is the documented mis-hour bug: a 7am summer class relayed as "6am"
// (live test 2026-06-12). Both files now import from here; booking-tools
// re-exports it so its public surface is unchanged.
//
// TZ.5 — the label is the STUDIO's wall clock (the conversation location's
// zone, carried on the tool context as ctx.zone), no longer Dublin for every
// studio. The file keeps its name (renaming it is churn); the Intl options are
// unchanged, so a Europe/Dublin label is byte-identical to before.
import { DEFAULT_TZ } from '@/lib/location-time'

const CLASS_TIME_OPTS = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}

/**
 * Format a unix-seconds instant as a wall-clock label in the studio's zone
 * that the model can relay verbatim, e.g. "Sat 13 Jun, 07:00". Glofox
 * time_start is an absolute instant; the model must never do timezone math.
 * The zone is explicit, so the machine's TZ is irrelevant. Pure.
 * @param {number} unixSec
 * @param {string} [zone] the location's IANA zone
 */
export function formatClassTime(unixSec, zone = DEFAULT_TZ) {
  const parts = {}
  for (const p of classTimeParts(new Date(unixSec * 1000), zone)) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
}

// One cached formatter per zone (the label needs formatToParts, which
// formatInZone does not expose). Keys are canonical zones from
// zoneOfLocation/getLocationZone, so the map is bounded by the IANA set.
const _fmts = new Map()
function classTimeParts(date, zone) {
  let f = _fmts.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-IE', { ...CLASS_TIME_OPTS, timeZone: zone })
    _fmts.set(zone, f)
  }
  return f.formatToParts(date)
}
