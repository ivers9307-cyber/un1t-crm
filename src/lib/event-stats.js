// HOSTSTATS.1 — one event's signup numbers, for the host event page, the
// staff teams page and the two stats routes.
//
// Three reads, each by race_event_id and paged past the 1,000-row cap
// (order + range; at most MAX_PAGES pages, `capped` when the cap hit):
//   event_page_views  → views (rows), unique visitors (distinct session_id),
//                       views by source
//   race_registrations → registrations (not cancelled), confirmed, and
//                       registrations by attribution.source ('unknown' when
//                       an entry carries none: staff-added, pre-feature)
//   event_waitlist    → waiting / offered / claimed
// conversion_pct = confirmed / unique visitors, one decimal; null with no
// visitors (an event older than the beacon), 0 with visitors and no bookings.
// A failed read on any table is { ok: false }: the card then says the stats
// are unavailable rather than showing a partial picture as the whole one.

import { sourceLabel } from '@/lib/event-attribution'

const PAGE_SIZE = 1000
const MAX_PAGES = 10

async function readAll(makeQuery) {
  const rows = []
  let capped = false
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) { capped = true; break }
    const from = page * PAGE_SIZE
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1)
    if (error) return { error }
    const batch = Array.isArray(data) ? data : []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return { rows, capped }
}

const round1 = (n) => Math.round(n * 10) / 10

/**
 * @returns {Promise<{ ok: true, stats } | { ok: false, error }>}
 */
export async function loadEventStats(db, eventId) {
  const views = await readAll(() => db.from('event_page_views').select('session_id, source').eq('race_event_id', eventId).order('created_at', { ascending: true }))
  if (views.error) return { ok: false, error: views.error }
  const regs = await readAll(() => db.from('race_registrations').select('status, attribution').eq('race_event_id', eventId).order('registered_at', { ascending: true }))
  if (regs.error) return { ok: false, error: regs.error }
  const wait = await readAll(() => db.from('event_waitlist').select('status').eq('race_event_id', eventId).order('created_at', { ascending: true }))
  if (wait.error) return { ok: false, error: wait.error }

  const sessions = new Set()
  const bySource = new Map()
  const bucket = (source) => {
    const key = source || 'unknown'
    if (!bySource.has(key)) bySource.set(key, { source: key, label: sourceLabel(key), views: 0, registrations: 0 })
    return bySource.get(key)
  }
  for (const v of views.rows) {
    if (v.session_id) sessions.add(v.session_id)
    bucket(v.source).views += 1
  }
  let registrations = 0
  let confirmed = 0
  for (const r of regs.rows) {
    if (r.status === 'cancelled') continue
    registrations += 1
    if (r.status === 'confirmed') confirmed += 1
    bucket(r.attribution?.source).registrations += 1
  }
  const waitlist = { waiting: 0, offered: 0, claimed: 0 }
  for (const w of wait.rows) if (w.status in waitlist) waitlist[w.status] += 1

  const unique_visitors = sessions.size
  const by_source = [...bySource.values()].sort((a, b) =>
    b.views - a.views || b.registrations - a.registrations || a.source.localeCompare(b.source))

  return {
    ok: true,
    stats: {
      views: views.rows.length,
      unique_visitors,
      registrations,
      confirmed,
      conversion_pct: unique_visitors === 0 ? null : round1((confirmed / unique_visitors) * 100),
      by_source,
      waitlist,
      capped: views.capped || regs.capped || wait.capped,
    },
  }
}
