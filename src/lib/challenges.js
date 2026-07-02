// Challenge leaderboard pure helpers. Byte-synced with champ-app/shared/challenges.js
// below line 1 EXCEPT the import path — un1t-crm resolves the Dublin day-boundary
// helpers via '@/lib/dublin-time', champ-app via './dublin-time.js' (line 5). The
// window/phase MATH is identical on both surfaces. No IO — standings DB reads live
// in challenges-io.js (un1t-crm) / load-challenges.js (champ-app).

import { dublinDayStartMs, dublinDateKey, DUBLIN_DAY_MS } from '@/lib/dublin-time'

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

// UTC-ms of 00:00 Europe/Dublin on a 'YYYY-MM-DD' challenge date.
// Challenge windows are Europe/Dublin CALENDAR days — a challenge that
// runs 10th → 20th includes every session on the Dublin 10th and 20th,
// and excludes a session at 00:30 Dublin on the 21st (which is 23:30 UTC
// on the 20th during IST — a UTC-midnight boundary would wrongly count
// it). MUST match the un1t-crm challenge_standings RPC day boundaries.
function dayMsDublin(dateStr) {
  return dublinDayStartMs(String(dateStr))
}

/** 'upcoming' | 'active' | 'ended' from inclusive Europe/Dublin day window. */
export function challengePhase(challenge, nowMs = Date.now()) {
  const start = dayMsDublin(challenge.starts_on)
  // end-exclusive = 00:00 Dublin on the day AFTER ends_on.
  const endExclusive = dublinDayStartMs(dublinDateKey(dayMsDublin(challenge.ends_on) + DUBLIN_DAY_MS))
  if (nowMs < start) return 'upcoming'
  if (nowMs < endExclusive) return 'active'
  return 'ended'
}

/** Inclusive Europe/Dublin day range → ISO window
 *  [00:00 Dublin start, 00:00 Dublin (end+1)). */
export function windowIso(challenge) {
  const endExclusive = dublinDayStartMs(dublinDateKey(dayMsDublin(challenge.ends_on) + DUBLIN_DAY_MS))
  return {
    fromIso: new Date(dayMsDublin(challenge.starts_on)).toISOString(),
    toIso: new Date(endExclusive).toISOString(),
  }
}

/** Full contact name → "First L." privacy projection. `contacts` has a single
 * `name` column (NOT first_name/last_name) — this mirrors /api/public/live's split. */
export function shortName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Member'
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0]
}

export { MONTH_NAMES }
