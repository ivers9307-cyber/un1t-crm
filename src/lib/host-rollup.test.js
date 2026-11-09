// HOSTPORTAL.3 — the Overview's "Last 30 days" counts.
import { describe, it, expect } from 'vitest'
import { loadHostRollup, loadRecentRatingCounts } from './host-rollup.js'

// A db stub that records every call and answers per table. A table listed in
// `fail` answers with an error; `counts` gives its count.
function makeDb({ counts = {}, fail = [] } = {}) {
  const calls = []
  const db = {
    from(table) {
      const call = { table, select: null, filters: [] }
      calls.push(call)
      const b = {}
      const chain = (name) => (...args) => { call.filters.push([name, ...args]); return b }
      b.select = (cols, opts) => { call.select = [cols, opts]; return b }
      for (const n of ['eq', 'gte', 'in']) b[n] = chain(n)
      b.then = (res, rej) => {
        const key = call.filters.some((f) => f[1] === 'source') ? 'signups'
          : table === 'host_contacts' ? 'contacts' : table
        const out = fail.includes(key)
          ? { count: null, error: { message: 'boom' } }
          : { count: counts[key] ?? 0, error: null }
        return Promise.resolve(out).then(res, rej)
      }
      return b
    },
  }
  return { db, calls }
}

const args = { hostId: 'h1', eventIds: ['e1', 'e2'], sinceIso: '2026-10-10T00:00:00.000Z', sinceDay: '2026-10-10' }

describe('loadHostRollup', () => {
  it('counts each figure with its own window and filters', async () => {
    const { db, calls } = makeDb({ counts: { race_registrations: 7, event_page_views: 120, signups: 5, contacts: 40 } })
    const r = await loadHostRollup(db, args)
    expect(r).toEqual({ bookings: 7, views: 120, signups: 5, contacts: 40 })
    for (const c of calls) expect(c.select[1]).toEqual({ count: 'exact', head: true })

    const reg = calls.find((c) => c.table === 'race_registrations')
    expect(reg.filters).toEqual(expect.arrayContaining([
      ['eq', 'status', 'confirmed'], ['gte', 'registered_at', args.sinceIso], ['in', 'race_event_id', ['e1', 'e2']],
    ]))
    const views = calls.find((c) => c.table === 'event_page_views')
    expect(views.filters).toEqual(expect.arrayContaining([
      ['gte', 'day', '2026-10-10'], ['in', 'race_event_id', ['e1', 'e2']],
    ]))
    const hc = calls.filter((c) => c.table === 'host_contacts')
    expect(hc).toHaveLength(2)
    const signups = hc.find((c) => c.filters.some((f) => f[1] === 'source'))
    expect(signups.filters).toEqual(expect.arrayContaining([
      ['eq', 'host_id', 'h1'], ['eq', 'source', 'mailing_list'], ['gte', 'created_at', args.sinceIso],
    ]))
    const all = hc.find((c) => !c.filters.some((f) => f[1] === 'source'))
    expect(all.filters).toEqual([['eq', 'host_id', 'h1']])
  })

  it('returns null for the one figure whose read failed and numbers for the rest', async () => {
    const { db } = makeDb({ counts: { race_registrations: 3, event_page_views: 9, contacts: 2 }, fail: ['signups'] })
    expect(await loadHostRollup(db, args)).toEqual({ bookings: 3, views: 9, signups: null, contacts: 2 })
  })

  it('answers 0 bookings and 0 views for a host with no events without querying', async () => {
    const { db, calls } = makeDb({ counts: { signups: 1, contacts: 4 } })
    const r = await loadHostRollup(db, { ...args, eventIds: [] })
    expect(r).toEqual({ bookings: 0, views: 0, signups: 1, contacts: 4 })
    expect(calls.map((c) => c.table)).toEqual(['host_contacts', 'host_contacts'])
  })

  it('chunks event ids by 100 and sums the chunks', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `e${i}`)
    const { db, calls } = makeDb({ counts: { race_registrations: 2 } })
    const r = await loadHostRollup(db, { ...args, eventIds: ids })
    const regCalls = calls.filter((c) => c.table === 'race_registrations')
    expect(regCalls).toHaveLength(3)
    expect(regCalls.map((c) => c.filters.find((f) => f[0] === 'in')[2].length)).toEqual([100, 100, 50])
    expect(r.bookings).toBe(6)
  })

  it('returns null when any chunk of a figure fails', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `e${i}`)
    const { db } = makeDb({ fail: ['event_page_views'] })
    const r = await loadHostRollup(db, { ...args, eventIds: ids })
    expect(r.views).toBeNull()
    expect(r.bookings).toBe(0)
  })
})

// HOSTPORTAL.4 — new ratings per event since a boundary.
function makeRatingsDb({ rows = [], failOnCall = null } = {}) {
  const calls = []
  const db = {
    from(table) {
      const call = { table, select: null, filters: [], orders: [], range: null }
      calls.push(call)
      const idx = calls.length
      const b = {}
      b.select = (cols) => { call.select = cols; return b }
      b.in = (...a) => { call.filters.push(['in', ...a]); return b }
      b.gte = (...a) => { call.filters.push(['gte', ...a]); return b }
      b.order = (...a) => { call.orders.push(a); return b }
      b.range = (from, to) => { call.range = [from, to]; return b }
      b.then = (res, rej) => {
        if (failOnCall === idx) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej)
        const ids = call.filters.find((f) => f[0] === 'in')[2]
        const [from, to] = call.range
        const mine = rows.filter((r) => ids.includes(r.race_event_id))
        return Promise.resolve({ data: mine.slice(from, to + 1), error: null }).then(res, rej)
      }
      return b
    },
  }
  return { db, calls }
}

describe('loadRecentRatingCounts', () => {
  const since = '2026-11-02T00:00:00.000Z'

  it('counts ratings per event since the boundary, hidden and public alike', async () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ race_event_id: 'e1' })),
      { race_event_id: 'e2' },
    ]
    const { db, calls } = makeRatingsDb({ rows })
    const m = await loadRecentRatingCounts(db, { eventIds: ['e1', 'e2', 'e3'], sinceIso: since })
    expect(m).toBeInstanceOf(Map)
    expect([...m.entries()]).toEqual([['e1', 3], ['e2', 1]])
    const c = calls[0]
    expect(c.table).toBe('event_ratings')
    expect(c.select).toBe('race_event_id')
    expect(c.filters).toEqual(expect.arrayContaining([['gte', 'created_at', since], ['in', 'race_event_id', ['e1', 'e2', 'e3']]]))
    expect(c.filters.some((f) => f[1] === 'is_public')).toBe(false)
    expect(c.orders).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]])
  })

  it('pages past 1,000 rows and chunks ids by 100', async () => {
    const rows = Array.from({ length: 1500 }, () => ({ race_event_id: 'e1' }))
    const { db, calls } = makeRatingsDb({ rows })
    const m = await loadRecentRatingCounts(db, { eventIds: ['e1'], sinceIso: since })
    expect(m.get('e1')).toBe(1500)
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])

    const ids = Array.from({ length: 150 }, (_, i) => `x${i}`)
    const second = makeRatingsDb({ rows: [] })
    await loadRecentRatingCounts(second.db, { eventIds: ids, sinceIso: since })
    expect(second.calls.map((c) => c.filters.find((f) => f[0] === 'in')[2].length)).toEqual([100, 50])
  })

  it('returns null when a page fails and an empty map for no ids', async () => {
    const { db } = makeRatingsDb({ rows: [{ race_event_id: 'e1' }], failOnCall: 1 })
    expect(await loadRecentRatingCounts(db, { eventIds: ['e1'], sinceIso: since })).toBeNull()

    const none = makeRatingsDb()
    const m = await loadRecentRatingCounts(none.db, { eventIds: [], sinceIso: since })
    expect(m).toEqual(new Map())
    expect(none.calls).toHaveLength(0)
  })
})
