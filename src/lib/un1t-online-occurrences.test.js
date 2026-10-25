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
      gt(c, v) { s.filters.push(['gt', c, v]); return api },
      is(c, v) { s.filters.push(['is', c, v]); return api },
      order() { return api },
      range() { return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => { log.push({ table: t }); return builder() } }, log }
}
const upsertEntries = (log) => log.filter((e) => e.op === 'upsert')
// The existing-cancelled reads (by id); the UN1TBOOK.20 reconcile read has no IN-list.
const selectEntries = (log) => log.filter((e) => e.op === 'select' && e.filters.some((f) => f[0] === 'in'))

describe('projectUn1tOccurrences', () => {
  it('upserts in chunks of 200 on location_id,glofox_event_id and never deletes', async () => {
    const events = Array.from({ length: 450 }, (_, i) => event({ un1t_id: `e${i}` }))
    const { db, log } = makeDb()
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events, nowIso: NOW })
    expect(r).toEqual({ upserted: 450, cancelled: 0 })
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
    expect(r).toEqual({ upserted: 2, cancelled: 0 })
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

// UN1TBOOK.20 — a FUTURE un1t occurrence whose event this pull did not return
// was deleted in un1t.online: it is stamped cancelled, so it leaves the TVs.
// A filter-applying fake over one class_occurrences table.
function makeTableDb(seed, { failReconcileRead = false, failUpdate = false } = {}) {
  const rows = seed.map((r) => ({ ...r }))
  const log = []
  const matches = (r, filters) => filters.every(([k, c, v]) => {
    if (k === 'eq') return r[c] === v
    if (k === 'in') return v.includes(r[c])
    if (k === 'gt') return r[c] != null && Date.parse(r[c]) > Date.parse(v)
    if (k === 'is') return v === null ? r[c] == null : r[c] === v
    return true
  })
  const builder = () => {
    const s = { op: 'select', filters: [], payload: null, options: null, range: null }
    const run = () => {
      log.push({ op: s.op, payload: s.payload, filters: s.filters })
      if (s.op === 'select') {
        const reconcile = !s.filters.some((f) => f[0] === 'in')
        if (reconcile && failReconcileRead) return { data: null, error: { code: '57014', message: 'reconcile read boom' } }
        let out = rows.filter((r) => matches(r, s.filters)).map((r) => ({ ...r }))
        if (s.range) out = out.slice(s.range[0], s.range[1] + 1)
        return { data: out, error: null }
      }
      if (s.op === 'upsert') {
        for (const p of s.payload) {
          const hit = rows.find((r) => r.location_id === p.location_id && r.glofox_event_id === p.glofox_event_id)
          if (hit) Object.assign(hit, p)
          else rows.push({ ...p })
        }
        return { data: null, error: null }
      }
      if (s.op === 'update') {
        if (failUpdate) return { data: null, error: { code: '40001', message: 'update boom' } }
        const hit = rows.filter((r) => matches(r, s.filters))
        for (const r of hit) Object.assign(r, s.payload)
        return { data: hit.map((r) => ({ glofox_event_id: r.glofox_event_id })), error: null }
      }
      throw new Error(`unexpected op ${s.op}`)
    }
    const api = {
      select() { return api },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      delete() { s.op = 'delete'; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      gt(c, v) { s.filters.push(['gt', c, v]); return api },
      is(c, v) { s.filters.push(['is', c, v]); return api },
      order() { return api },
      range(a, b) { s.range = [a, b]; return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: () => builder() }, rows, log }
}

const FUTURE = '2026-10-22T17:30:00.000Z'
const PAST = '2026-10-15T17:30:00.000Z'
const occ = (over = {}) => ({
  location_id: LOC, glofox_event_id: 'un1t:gone', source_platform: 'un1t_online', name: 'Gone', starts_at: FUTURE, cancelled_at: null, ...over,
})
const byId = (rows, id) => rows.find((r) => r.glofox_event_id === id)

describe('projectUn1tOccurrences: a class deleted in un1t.online (UN1TBOOK.20)', () => {
  it('stamps cancelled_at on a FUTURE un1t occurrence this pull did not return, and never deletes', async () => {
    const { db, rows, log } = makeTableDb([occ()])
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'e1' })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 1 })
    expect(byId(rows, 'un1t:gone').cancelled_at).toBe(NOW)
    expect(byId(rows, 'un1t:e1').cancelled_at).toBeNull()
    expect(log.some((e) => e.op === 'delete')).toBe(false)
    // The cancel is bounded: this studio, un1t rows, the future, not yet cancelled.
    const upd = log.find((e) => e.op === 'update')
    expect(upd.payload).toEqual({ cancelled_at: NOW })
    expect(upd.filters).toEqual(expect.arrayContaining([
      ['eq', 'location_id', LOC], ['eq', 'source_platform', 'un1t_online'], ['gt', 'starts_at', NOW], ['is', 'cancelled_at', null], ['in', 'glofox_event_id', ['un1t:gone']],
    ]))
  })

  it('a stamped class that reappears in a later pull is un-cancelled', async () => {
    const { db, rows } = makeTableDb([occ({ glofox_event_id: 'un1t:back', cancelled_at: '2026-10-15T09:00:00.000Z' })])
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'back', starts_at: FUTURE })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 0 })
    expect(byId(rows, 'un1t:back').cancelled_at).toBeNull()
  })

  it('a PAST un1t occurrence absent from the pull is untouched (the list is a window; the past rolls off it)', async () => {
    const { db, rows, log } = makeTableDb([occ({ glofox_event_id: 'un1t:old', starts_at: PAST })])
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'e1' })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 0 })
    expect(byId(rows, 'un1t:old').cancelled_at).toBeNull()
    expect(log.some((e) => e.op === 'update')).toBe(false)
  })

  it('a Glofox occurrence (and another studio\'s) is never touched', async () => {
    const { db, rows } = makeTableDb([
      occ({ glofox_event_id: 'a'.repeat(24), source_platform: 'glofox' }),
      occ({ glofox_event_id: 'un1t:elsewhere', location_id: 'loc-other' }),
    ])
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'e1' })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 0 })
    expect(byId(rows, 'a'.repeat(24)).cancelled_at).toBeNull()
    expect(byId(rows, 'un1t:elsewhere').cancelled_at).toBeNull()
  })

  it('a pull that returned no events cancels nothing (an empty list is an upstream fault, not every class deleted)', async () => {
    const { db, rows, log } = makeTableDb([occ()])
    expect(await projectUn1tOccurrences(db, { locationId: LOC, events: [], nowIso: NOW })).toEqual({ upserted: 0 })
    expect(byId(rows, 'un1t:gone').cancelled_at).toBeNull()
    expect(log).toEqual([])
  })

  it('an event the pull returned without a start still counts as seen (never cancelled for an unmappable row)', async () => {
    const { db, rows } = makeTableDb([occ({ glofox_event_id: 'un1t:nostart' })])
    const r = await projectUn1tOccurrences(db, {
      locationId: LOC, events: [event({ un1t_id: 'e1' }), event({ un1t_id: 'nostart', starts_at: null })], nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 1, cancelled: 0 })
    expect(byId(rows, 'un1t:nostart').cancelled_at).toBeNull()
  })

  it('a failed reconcile read cancels nothing and returns the error (the upsert stands)', async () => {
    const { db, rows, log } = makeTableDb([occ()], { failReconcileRead: true })
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'e1' })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 0, error: { code: '57014', message: 'reconcile read boom' } })
    expect(byId(rows, 'un1t:gone').cancelled_at).toBeNull()
    expect(log.some((e) => e.op === 'update')).toBe(false)
  })

  it('a failed cancel write returns the error, never throws', async () => {
    const { db } = makeTableDb([occ()], { failUpdate: true })
    const r = await projectUn1tOccurrences(db, { locationId: LOC, events: [event({ un1t_id: 'e1' })], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, cancelled: 0, error: { code: '40001', message: 'update boom' } })
  })
})
