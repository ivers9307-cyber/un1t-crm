import { describe, it, expect } from 'vitest'
import { mapUn1tEventToOccurrence, projectUn1tOccurrences } from './un1t-online-occurrences.js'

const LOC = 'loc-hatch'
const NOW = '2026-10-16T10:00:00.000Z'

const event = (over = {}) => ({
  location_id: LOC,
  un1t_id: 'e1',
  title: 'HYROX Tuesday',
  status: 'scheduled',
  access_mode: 'members',
  is_free: false,
  starts_at: '2026-10-20T17:30:00.000Z',
  ends_at: '2026-10-20T18:30:00.000Z',
  capacity: 14,
  bookings_count: 9,
  series_id: 'ser-1',
  raw: { huge: 'payload' },
  synced_at: NOW,
  ...over,
})

describe('mapUn1tEventToOccurrence', () => {
  it('maps a un1t event to an occurrence with the un1t: id and source_platform', () => {
    expect(mapUn1tEventToOccurrence(event(), { locationId: LOC, nowIso: NOW, existingCancelledAt: null })).toEqual({
      location_id: LOC,
      glofox_event_id: 'un1t:e1',
      source_platform: 'un1t_online',
      name: 'HYROX Tuesday',
      program: null,
      starts_at: '2026-10-20T17:30:00.000Z',
      ends_at: '2026-10-20T18:30:00.000Z',
      capacity: 14,
      instructor: null,
      raw: { booked: 9, un1t: { status: 'scheduled', access_mode: 'members', is_free: false, series_id: 'ser-1' } },
      synced_at: NOW,
      cancelled_at: null,
    })
  })

  it('cancelled status sets cancelled_at to now; an existing cancelled_at is kept; a scheduled event clears it', () => {
    const ctx = { locationId: LOC, nowIso: NOW }
    expect(mapUn1tEventToOccurrence(event({ status: 'cancelled' }), { ...ctx, existingCancelledAt: null }).cancelled_at).toBe(NOW)
    const earlier = '2026-10-10T08:00:00.000Z'
    expect(mapUn1tEventToOccurrence(event({ status: 'cancelled' }), { ...ctx, existingCancelledAt: earlier }).cancelled_at).toBe(earlier)
    expect(mapUn1tEventToOccurrence(event({ status: 'scheduled' }), { ...ctx, existingCancelledAt: earlier }).cancelled_at).toBeNull()
    expect(mapUn1tEventToOccurrence(event({ status: 'completed' }), { ...ctx, existingCancelledAt: earlier }).cancelled_at).toBeNull()
  })

  it('the id is always prefixed, so it never equals a bare 24-hex Glofox id', () => {
    const glofoxLike = 'a'.repeat(24)
    const row = mapUn1tEventToOccurrence(event({ un1t_id: glofoxLike }), { locationId: LOC, nowIso: NOW })
    expect(row.glofox_event_id).toBe(`un1t:${glofoxLike}`)
    expect(row.glofox_event_id).not.toBe(glofoxLike)
    expect(/^[0-9a-f]{24}$/.test(row.glofox_event_id)).toBe(false)
  })

  it('returns null for a row with no id or no start (nothing to put on a timetable)', () => {
    const ctx = { locationId: LOC, nowIso: NOW }
    expect(mapUn1tEventToOccurrence(event({ un1t_id: null }), ctx)).toBeNull()
    expect(mapUn1tEventToOccurrence(event({ starts_at: null }), ctx)).toBeNull()
    expect(mapUn1tEventToOccurrence(null, ctx)).toBeNull()
  })
})

// A minimal recording fake: select-with-filters on class_occurrences, upsert.
function makeDb({ existing = [], failSelect = false, failUpsertAt = null } = {}) {
  const log = []
  let upsertCalls = 0
  const builder = () => {
    const s = { op: 'select', filters: [], payload: null, options: null }
    const run = () => {
      log.push({ op: s.op, payload: s.payload, filters: s.filters, options: s.options })
      if (s.op === 'select') {
        if (failSelect) return { data: null, error: { code: '57014', message: 'read boom', details: 'SECRET' } }
        const ids = s.filters.find((f) => f[0] === 'in')?.[2] || []
        return { data: existing.filter((r) => ids.includes(r.glofox_event_id)), error: null }
      }
      upsertCalls += 1
      if (failUpsertAt === upsertCalls) return { data: null, error: { code: '23514', message: 'upsert boom', details: 'Failing row contains (SECRET)' } }
      return { data: null, error: null }
    }
    const api = {
      select() { return api },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => { log.push({ table: t }); return builder() } }, log }
}
const upsertEntries = (log) => log.filter((e) => e.op === 'upsert')
const selectEntries = (log) => log.filter((e) => e.op === 'select')

describe('projectUn1tOccurrences', () => {
  it('upserts in chunks of 200 on location_id,glofox_event_id and never deletes', async () => {
    const events = Array.from({ length: 450 }, (_, i) => event({ un1t_id: `e${i}` }))
    const { db, log } = makeDb()
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events, nowIso: NOW })
    expect(r).toEqual({ upserted: 450 })
    const ups = upsertEntries(log)
    expect(ups.map((u) => u.payload.length)).toEqual([200, 200, 50])
    for (const u of ups) expect(u.options).toEqual({ onConflict: 'location_id,glofox_event_id' })
    // The existing-cancelled read is chunked at 100 (a long PostgREST IN-list URL) and scoped to the location.
    const sels = selectEntries(log)
    expect(sels.map((s) => s.filters.find((f) => f[0] === 'in')[2].length)).toEqual([100, 100, 100, 100, 50])
    for (const s of sels) expect(s.filters).toContainEqual(['eq', 'location_id', LOC])
    expect(log.some((e) => e.op === 'delete')).toBe(false)
  })

  it('reads the existing cancelled_at by the prefixed id and keeps an earlier one', async () => {
    const earlier = '2026-10-10T08:00:00.000Z'
    const { db, log } = makeDb({ existing: [{ glofox_event_id: 'un1t:e1', cancelled_at: earlier }] })
    const r = await projectUn1tOccurrences(db, {
      locationId: LOC,
      events: [event({ un1t_id: 'e1', status: 'cancelled' }), event({ un1t_id: 'e2', status: 'cancelled' })],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 2 })
    expect(selectEntries(log)[0].filters.find((f) => f[0] === 'in')[2]).toEqual(['un1t:e1', 'un1t:e2'])
    const payload = upsertEntries(log)[0].payload
    expect(payload.find((p) => p.glofox_event_id === 'un1t:e1').cancelled_at).toBe(earlier)
    expect(payload.find((p) => p.glofox_event_id === 'un1t:e2').cancelled_at).toBe(NOW)
  })

  it('does nothing for no events and skips unmappable rows', async () => {
    const { db, log } = makeDb()
    expect(await projectUn1tOccurrences(db, { locationId: LOC, events: [], nowIso: NOW })).toEqual({ upserted: 0 })
    expect(await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ starts_at: null })], nowIso: NOW })).toEqual({ upserted: 0 })
    expect(log).toEqual([])
  })

  it('an upsert failure returns { error: {code, message} } with no details, and never throws', async () => {
    const { db } = makeDb({ failUpsertAt: 1 })
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event()], nowIso: NOW })
    expect(r).toEqual({ error: { code: '23514', message: 'upsert boom' } })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('a failed existing-cancelled read writes nothing and returns the error', async () => {
    const { db, log } = makeDb({ failSelect: true })
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event()], nowIso: NOW })
    expect(r).toEqual({ error: { code: '57014', message: 'read boom' } })
    expect(upsertEntries(log)).toHaveLength(0)
  })

  it('an exception thrown by the client is returned, not thrown', async () => {
    const db = { from: () => { throw new Error('client exploded') } }
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event()], nowIso: NOW })
    expect(r.error.message).toContain('client exploded')
  })
})
