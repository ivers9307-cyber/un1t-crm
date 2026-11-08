// HOSTSTATS.1 — one event's signup numbers, for the host event page, the
// staff teams page and the two stats routes.
//
// Three reads, each by race_event_id and paged past the 1,000-row cap
// (order + range; at most MAX_PAGES pages, `capped` when the cap hit):
//   event_page_views  → views (rows), unique visitors (distinct session_id),
//                       views by source
//   race_registrations → registrations (not cancelled), confirmed, and
//                       CONFIRMED bookings by attribution.source ('unknown'
//                       when an entry carries none: staff-added, pre-feature),
//                       so the per-source "booked" adds up to the headline
//   event_waitlist    → waiting / offered / claimed
// conversion_pct = confirmed / unique visitors, one decimal; null with no
// visitors (an event older than the beacon), 0 with visitors and no bookings.
// A failed read on any table is { ok: false }: the card then says the stats
// are unavailable rather than showing a partial picture as the whole one.

import { attributionSourceLabel } from '@/lib/event-attribution'

const PAGE_SIZE = 1000
const MAX_PAGES = 10
// The card lists at most this many sources; the rest fold into one 'other'
// line, so an unauthenticated beacon cannot fill the card with lines.
export const MAX_SOURCES = 8

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
    if (!bySource.has(key)) bySource.set(key, { source: key, label: attributionSourceLabel(key), views: 0, booked: 0 })
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
    if (r.status !== 'confirmed') continue
    confirmed += 1
    bucket(r.attribution?.source).booked += 1
  }
  const waitlist = { waiting: 0, offered: 0, claimed: 0 }
  for (const w of wait.rows) if (w.status in waitlist) waitlist[w.status] += 1

  const unique_visitors = sessions.size
  const ranked = [...bySource.values()]
    .filter((x) => x.views > 0 || x.booked > 0)
    .sort((a, b) => b.views - a.views || b.booked - a.booked || a.source.localeCompare(b.source))
  const by_source = ranked.length > MAX_SOURCES + 1
    ? [...ranked.slice(0, MAX_SOURCES), ranked.slice(MAX_SOURCES).reduce(
        (acc, x) => ({ ...acc, views: acc.views + x.views, booked: acc.booked + x.booked }),
        { source: 'other', label: attributionSourceLabel('other'), views: 0, booked: 0 },
      )]
    : ranked

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
