// TZ.1 — src/lib/location-time.js: the DB side of the zone maths (a location's
// zone, cached 60 s per instance, never caching a failed read).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import * as Shared from '@shared/zoned-time'
import {
  getLocationZone, getLocationZones, zoneOfLocation, resetLocationZoneCache,
  DEFAULT_TZ, PLATFORM_TZ, todayStrIn,
} from './location-time'

const NY = 'America/New_York'
const DUBLIN = 'Europe/Dublin'

// A fake service-role client over a `locations` table held in a Map. Records
// every query so a test can count round trips. `fail` makes the next N reads
// resolve { error } the way a PostgREST builder does (resolved, not thrown).
function fakeDb(rows = {}) {
  const calls = []
  let fail = 0
  const db = {
    calls,
    failNext(n = 1) { fail = n },
    from(table) {
      expect(table).toBe('locations')
      return {
        select(cols) {
          expect(cols).toBe('id, timezone')
          return {
            eq(col, id) {
              expect(col).toBe('id')
              calls.push({ kind: 'one', id })
              return {
                maybeSingle: async () => {
                  if (fail > 0) { fail--; return { data: null, error: { message: 'boom' } } }
                  return { data: id in rows ? { id, timezone: rows[id] } : null, error: null }
                },
              }
            },
            in(col, ids) {
              expect(col).toBe('id')
              const call = { kind: 'many', ids: [...ids], order: null }
              calls.push(call)
              return {
                order: async (orderCol) => {
                  call.order = orderCol
                  if (fail > 0) { fail--; return { data: null, error: { message: 'boom' } } }
                  return { data: ids.filter((i) => i in rows).map((i) => ({ id: i, timezone: rows[i] })), error: null }
                },
              }
            },
          }
        },
      }
    },
  }
  return db
}

beforeEach(() => {
  resetLocationZoneCache()
  vi.mocked(logWarn).mockClear()
})

describe('getLocationZone', () => {
  it('reads the column, canonicalised', async () => {
    const db = fakeDb({ a: 'america/new_york' })
    expect(await getLocationZone(db, 'a', { nowMs: 1_000 })).toBe(NY)
  })

  it('a hit within 60 s makes no second query; at 60 s it re-reads', async () => {
    const db = fakeDb({ a: NY })
    await getLocationZone(db, 'a', { nowMs: 1_000 })
    await getLocationZone(db, 'a', { nowMs: 1_000 + 59_999 })
    expect(db.calls).toHaveLength(1)
    await getLocationZone(db, 'a', { nowMs: 1_000 + 60_000 })
    expect(db.calls).toHaveLength(2)
  })

  it('a read error returns Europe/Dublin, logs, and is NOT cached', async () => {
    const db = fakeDb({ a: NY })
    db.failNext(1)
    expect(await getLocationZone(db, 'a', { nowMs: 1_000 })).toBe(DUBLIN)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logWarn).mock.calls[0][0]).toBe('location-time')
    // the very next call queries again and gets the real zone
    expect(await getLocationZone(db, 'a', { nowMs: 1_001 })).toBe(NY)
    expect(db.calls).toHaveLength(2)
  })

  it('an invalid stored value returns Europe/Dublin and warns once per location', async () => {
    const db = fakeDb({ a: 'Europe/Dubln', b: '+05:30' })
    expect(await getLocationZone(db, 'a', { nowMs: 1_000 })).toBe(DUBLIN)
    expect(await getLocationZone(db, 'a', { nowMs: 1_000 + 120_000 })).toBe(DUBLIN) // re-read after TTL
    expect(db.calls).toHaveLength(2)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(await getLocationZone(db, 'b', { nowMs: 1_000 })).toBe(DUBLIN)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('a NULL column or a missing row is the Dublin floor, silently', async () => {
    const db = fakeDb({ a: null })
    expect(await getLocationZone(db, 'a', { nowMs: 1_000 })).toBe(DUBLIN)
    expect(await getLocationZone(db, 'missing', { nowMs: 1_000 })).toBe(DUBLIN)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('no location id → Europe/Dublin with no query', async () => {
    const db = fakeDb({})
    expect(await getLocationZone(db, null)).toBe(DUBLIN)
    expect(await getLocationZone(db, undefined)).toBe(DUBLIN)
    expect(db.calls).toHaveLength(0)
  })
})

describe('getLocationZones (crons)', () => {
  it('1,200 ids → 3 .in() queries of ≤500, each ordered by id', async () => {
    const rows = {}
    const ids = []
    for (let i = 0; i < 1200; i++) { const id = `loc-${String(i).padStart(4, '0')}`; ids.push(id); rows[id] = i % 2 ? NY : DUBLIN }
    const db = fakeDb(rows)
    const out = await getLocationZones(db, ids, { nowMs: 1_000 })
    expect(db.calls.map((c) => c.ids.length)).toEqual([500, 500, 200])
    expect(db.calls.every((c) => c.kind === 'many' && c.order === 'id')).toBe(true)
    expect(out.size).toBe(1200)
    expect(out.get('loc-0001')).toBe(NY)
    expect(out.get('loc-0002')).toBe(DUBLIN)
  })

  it('drops falsy and duplicate ids; an id with no row is the Dublin floor', async () => {
    const db = fakeDb({ a: NY })
    const out = await getLocationZones(db, ['a', 'a', null, '', 'ghost'], { nowMs: 1_000 })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].ids).toEqual(['a', 'ghost'])
    expect([...out.entries()]).toEqual([['a', NY], ['ghost', DUBLIN]])
  })

  it('serves cached ids and queries only the rest; shares the cache with getLocationZone', async () => {
    const db = fakeDb({ a: NY, b: 'Australia/Sydney' })
    await getLocationZone(db, 'a', { nowMs: 1_000 })
    const out = await getLocationZones(db, ['a', 'b'], { nowMs: 2_000 })
    expect(db.calls[1].ids).toEqual(['b'])
    expect(out.get('a')).toBe(NY)
    expect(out.get('b')).toBe('Australia/Sydney')
    expect(await getLocationZone(db, 'b', { nowMs: 3_000 })).toBe('Australia/Sydney')
    expect(db.calls).toHaveLength(2)
  })

  it('a failed batch is the Dublin floor for those ids, logged, and NOT cached', async () => {
    const db = fakeDb({ a: NY })
    db.failNext(1)
    const out = await getLocationZones(db, ['a'], { nowMs: 1_000 })
    expect(out.get('a')).toBe(DUBLIN)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect((await getLocationZones(db, ['a'], { nowMs: 1_001 })).get('a')).toBe(NY)
    expect(db.calls).toHaveLength(2)
  })

  it('an empty or missing list makes no query', async () => {
    const db = fakeDb({})
    expect((await getLocationZones(db, [])).size).toBe(0)
    expect((await getLocationZones(db, undefined)).size).toBe(0)
    expect(db.calls).toHaveLength(0)
  })
})

describe('zoneOfLocation (a row already in hand)', () => {
  it('resolves without IO, and seeds the cache when the row has an id', async () => {
    expect(zoneOfLocation(null)).toBe(DUBLIN)
    expect(zoneOfLocation({ timezone: NY })).toBe(NY)
    expect(zoneOfLocation({ timezone: 'garbage' })).toBe(DUBLIN)
    expect(zoneOfLocation({ id: 'a', timezone: 'america/new_york' })).toBe(NY)
    const db = fakeDb({ a: DUBLIN })
    expect(await getLocationZone(db, 'a')).toBe(NY) // served from the seeded entry
    expect(db.calls).toHaveLength(0)
  })

  it('warns once for an invalid value on an identified row', () => {
    expect(zoneOfLocation({ id: 'x', timezone: 'Mars/Olympus' })).toBe(DUBLIN)
    expect(zoneOfLocation({ id: 'x', timezone: 'Mars/Olympus' })).toBe(DUBLIN)
    expect(logWarn).toHaveBeenCalledTimes(1)
  })
})

describe('resetLocationZoneCache', () => {
  it('forces a re-read of one location, or of all', async () => {
    const db = fakeDb({ a: NY, b: NY })
    await getLocationZone(db, 'a', { nowMs: 1_000 })
    await getLocationZone(db, 'b', { nowMs: 1_000 })
    resetLocationZoneCache('a')
    await getLocationZone(db, 'a', { nowMs: 1_001 })
    await getLocationZone(db, 'b', { nowMs: 1_001 })
    expect(db.calls.map((c) => c.id)).toEqual(['a', 'b', 'a'])
    resetLocationZoneCache()
    await getLocationZone(db, 'b', { nowMs: 1_002 })
    expect(db.calls.map((c) => c.id)).toEqual(['a', 'b', 'a', 'b'])
  })
})

describe('the zone maths is re-exported, not copied', () => {
  it('every shared/zoned-time export is the same binding here', async () => {
    const web = await import('./location-time')
    for (const n of Object.keys(Shared)) expect(web[n], n).toBe(Shared[n])
    expect(DEFAULT_TZ).toBe(DUBLIN)
    expect(PLATFORM_TZ).toBe(DUBLIN)
    expect(todayStrIn(NY, Date.parse('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
  })
})
