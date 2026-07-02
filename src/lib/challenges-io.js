// Standings IO for challenges (un1t-crm side: operator API, TV endpoint, cron).
// Paginated read of ended, contact-bound sessions in the window at the location;
// aggregates the pure metricValue per contact; ranks + projects names.
import { metricValue, rankStandings, shortName } from '@/lib/challenges'
import { logWarn } from '@/lib/log'

const PAGE = 1000
const HARD_LIMIT = 20000

// Attendance rule (Richard, 2026-07-03; mirrors the mig 347 challenge_standings
// RPC): a session counts toward the "classes" metric ONLY if it is BOTH
// class-linked (glofox_event_id stamped — in-studio strap presence OR a wearable
// auto-mapped to a booked class) AND device-backed (NOT a no-device
// 'participation'/'manual' credit — those can carry a glofox_event_id but have no
// device behind them). Off-site wearable imports leave glofox_event_id null.
// Points + z4plus stay fully inclusive over all sessions.
export function countsAsAttendance(session) {
  const src = session?.source
  return session?.glofox_event_id != null && src !== 'participation' && src !== 'manual'
}

async function loadWindowSessions(db, { locationId, fromIso, toIso }) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id, source, glofox_event_id, effort_points, zones_seconds, contacts!heart_rate_sessions_contact_id_fkey(name)')
      .eq('location_id', locationId)
      .not('contact_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('started_at', fromIso)
      .lt('started_at', toIso)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { logWarn('challenges-io', 'window sessions read failed', { err: error, locationId }); break }
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
    if (out.length >= HARD_LIMIT) break
  }
  return out
}

export async function computeStandings(db, { locationId, metric, fromIso, toIso }) {
  const sessions = await loadWindowSessions(db, { locationId, fromIso, toIso })
  const byContact = new Map()
  for (const s of sessions) {
    const cur = byContact.get(s.contact_id) || { contactId: s.contact_id, value: 0, c: s.contacts }
    // The "classes" (attendance) metric is class-linked AND device-backed only;
    // points + z4plus stay fully inclusive (see countsAsAttendance / mig 347).
    if (metric === 'classes') {
      if (countsAsAttendance(s)) cur.value += 1
    } else {
      cur.value += metricValue(s, metric)
    }
    byContact.set(s.contact_id, cur)
  }
  const rows = [...byContact.values()].map((r) => ({
    contactId: r.contactId,
    value: Math.round(r.value * 100) / 100,
    name: shortName(r.c?.name),
  }))
  return rankStandings(rows)
}

export async function computeCollective(db, { locationId, metric, fromIso, toIso, target }) {
  const sessions = await loadWindowSessions(db, { locationId, fromIso, toIso })
  const contribute = metric === 'classes'
    ? (s) => (countsAsAttendance(s) ? 1 : 0)
    : (s) => metricValue(s, metric)
  const total = Math.round(sessions.reduce((a, s) => a + contribute(s), 0) * 100) / 100
  const tgt = Number(target) || 0
  return { total, target: tgt, pct: tgt > 0 ? Math.min(1, total / tgt) : 0 }
}
