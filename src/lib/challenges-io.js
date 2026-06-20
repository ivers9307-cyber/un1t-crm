// Standings IO for challenges (un1t-crm side: operator API, TV endpoint, cron).
// Paginated read of ended, contact-bound sessions in the window at the location;
// aggregates the pure metricValue per contact; ranks + projects names.
import { metricValue, rankStandings, shortName } from '@/lib/challenges'
import { logWarn } from '@/lib/log'

const PAGE = 1000
const HARD_LIMIT = 20000

async function loadWindowSessions(db, { locationId, fromIso, toIso }) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id, effort_points, zones_seconds, contacts!heart_rate_sessions_contact_id_fkey(name)')
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
    cur.value += metricValue(s, metric)
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
  const total = Math.round(sessions.reduce((a, s) => a + metricValue(s, metric), 0) * 100) / 100
  const tgt = Number(target) || 0
  return { total, target: tgt, pct: tgt > 0 ? Math.min(1, total / tgt) : 0 }
}
