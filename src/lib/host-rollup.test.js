// HOSTPORTAL.3 — the Overview's "Last 30 days" counts.
import { describe, it, expect } from 'vitest'
import { loadHostRollup } from './host-rollup.js'

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
