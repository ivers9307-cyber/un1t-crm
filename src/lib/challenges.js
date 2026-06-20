// Challenge leaderboard pure helpers. Byte-synced with champ-app/shared/challenges.js
// (only line 1 differs). No IO — standings DB reads live in challenges-io.js
// (un1t-crm) / load-challenges.js (champ-app).

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

function dayMsUtc(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 'upcoming' | 'active' | 'ended' from inclusive day window, UTC. */
export function challengePhase(challenge, nowMs = Date.now()) {
  const DAY = 24 * 3600 * 1000
  const start = dayMsUtc(challenge.starts_on)
  const endExclusive = dayMsUtc(challenge.ends_on) + DAY
  if (nowMs < start) return 'upcoming'
  if (nowMs < endExclusive) return 'active'
  return 'ended'
}

/** Inclusive day range → ISO window [start 00:00Z, (end+1) 00:00Z). */
export function windowIso(challenge) {
  const DAY = 24 * 3600 * 1000
  return {
    fromIso: new Date(dayMsUtc(challenge.starts_on)).toISOString(),
    toIso: new Date(dayMsUtc(challenge.ends_on) + DAY).toISOString(),
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
