// KEEP IN SYNC with un1t-crm/src/lib/challenges.js (verbatim copy below line 1).
// (only line 1 differs). No IO — standings DB reads live in challenges-io.js
// (un1t-crm) / load-challenges.js (champ-app).

import { dayStartMsIn, addDaysIn, DEFAULT_TZ } from './zoned-time.js'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

/** Per-session contribution for a challenge metric. */
export function metricValue(session, metric) {
  const z = session?.zones_seconds || {}
  const sec = (n) => Number(z[n] ?? z[String(n)]) || 0
  if (metric === 'points') return Number(session?.effort_points) || 0
  if (metric === 'classes') return 1
  if (metric === 'z4plus_minutes') return (sec(4) + sec(5)) / 60
  return 0
}

/** Sort rows by value desc; ties share a rank (1,2,2,4…). Rows: {contactId, value, ...}. */
export function rankStandings(rows) {
  const sorted = [...(rows || [])].sort((a, b) => (b.value || 0) - (a.value || 0))
  let lastVal = null
  let lastRank = 0
  return sorted.map((row, i) => {
    const v = row.value || 0
    const rank = v === lastVal ? lastRank : i + 1
    lastVal = v
    lastRank = rank
    return { ...row, rank }
  })
}

// UTC-ms of 00:00 in the CHALLENGE's studio zone on a 'YYYY-MM-DD' date.
// Challenge windows are calendar days in the zone of the challenge's own
// location (challenges.location_id → locations.timezone; TZ.13, D7), so every
// participant shares ONE window. A challenge that runs 10th → 20th includes
// every session on the local 10th and 20th, and excludes a session at 00:30
// local on the 21st (23:30 UTC on the 20th during Irish summer time — a
// UTC-midnight boundary would wrongly count it). The caller resolves the zone
// (getLocationZone / zoneOfLocation); omitted, it is Europe/Dublin. The
// challenge_standings RPC takes the instants computed here, so the two agree.
function dayStartIn(dateStr, zone) {
  return dayStartMsIn(String(dateStr), zone)
}

// End-exclusive = 00:00 local on the day AFTER ends_on, stepped with addDaysIn
// (anchored at local noon). TZ.13: this used to be midnight + 24h, which on a
// clocks-back Sunday (a 25-hour day: 25 Oct 2026 in Dublin, 1 Nov 2026 in New
// York) lands at 23:00 the SAME day, so a challenge ending that Sunday lost its
// last day (the DUBLINDAY.1 shape dublinDayRangeMs already fixed).
function endExclusiveIn(endsOn, zone) {
  return dayStartIn(addDaysIn(String(endsOn), 1, zone), zone)
}

/** 'upcoming' | 'active' | 'ended' from the inclusive local-day window in `zone`
 *  (the challenge's studio zone). */
export function challengePhase(challenge, nowMs = Date.now(), zone = DEFAULT_TZ) {
  const start = dayStartIn(challenge.starts_on, zone)
  const endExclusive = endExclusiveIn(challenge.ends_on, zone)
  if (nowMs < start) return 'upcoming'
  if (nowMs < endExclusive) return 'active'
  return 'ended'
}

/** Inclusive local-day range in `zone` (the challenge's studio zone) → ISO
 *  window [00:00 local start, 00:00 local (end+1)). */
export function windowIso(challenge, zone = DEFAULT_TZ) {
  return {
    fromIso: new Date(dayStartIn(challenge.starts_on, zone)).toISOString(),
    toIso: new Date(endExclusiveIn(challenge.ends_on, zone)).toISOString(),
  }
}

/** Full contact name → "First L." privacy projection. `contacts` has a single
 * `name` column (NOT first_name/last_name) — this mirrors /api/public/tv-live's split. */
export function shortName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Member'
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0]
}

export { MONTH_NAMES }
