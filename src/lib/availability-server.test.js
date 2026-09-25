// AVAIL.1 — the availability data layer. The RPC's own rules are pinned by
// tests/migration-630-staff-availability.test.js; this file pins what the
// routes rely on: the body schema, the reads' filters and shapes, and that a
// failed read or save is an error, never an empty answer.

import { describe, it, expect } from 'vitest'
import { WEEKDAY_CODES } from '@/lib/roster'
import { AVAILABILITY_WEEKDAYS } from '@shared/availability'
import {
  AvailabilityPutSchema, readOwnAvailability, saveOwnAvailability, readStudioAvailability, isAvailabilityInputError,
} from './availability-server'

// A recording fake: each from() gets a builder whose chain methods record
// their arguments and whose await resolves handlers[table](call).
function fakeDb(handlers, rpc = null) {
  const calls = []
  return {
    calls,
    rpc: rpc || (async () => ({ data: null, error: null })),
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const b = {}
      for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'limit', 'range']) {
        b[m] = (...args) => { call.ops.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve().then(() => handlers[table](call)).then(resolve, reject)
      return b
    },
  }
}
const op = (call, name) => call.ops.find((o) => o[0] === name)

describe('weekday codes', () => {
  it('match the roster code (shift_templates.days_of_week)', () => {
    expect([...AVAILABILITY_WEEKDAYS]).toEqual([...WEEKDAY_CODES])
  })
})

describe('AvailabilityPutSchema', () => {
  it('accepts the documented body and defaults the lists and all_day', () => {
    const r = AvailabilityPutSchema.safeParse({ weekly: [{ weekday: 'mon', start_time: '09:00', end_time: '12:00' }] })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ weekly: [{ weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00' }], dated: [] })
  })
  it.each([
    [{ weekly: [{ weekday: 'monday', all_day: true }] }],
    [{ dated: [{ start_date: '2026-02-30', all_day: true }] }],
    [{ weekly: [{ weekday: 'mon', start_time: '9am', end_time: '10am' }] }],
    [{ weekly: [{ weekday: 'mon', all_day: true, note: 'x'.repeat(201) }] }],
    [{ weekly: 'mon' }],
  ])('refuses %j', (body) => expect(AvailabilityPutSchema.safeParse(body).success).toBe(false))
})

describe('readOwnAvailability', () => {
  it("reads the person's weekly + not-yet-ended dated rules and returns them sorted, without ids", async () => {
    const db = fakeDb({
      staff_unavailability: () => ({
        data: [
          { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
          { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00:00', end_time: '12:00:00', note: null },
        ],
        error: null,
      }),
    })
    const { data, error } = await readOwnAvailability(db, 'p1', '2026-09-25')
    expect(error).toBeNull()
    expect(data.weekly).toEqual([{ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }])
    expect(data.dated[0]).toMatchObject({ start_date: '2026-10-03', note: 'Wedding' })
    const call = db.calls[0]
    expect(op(call, 'eq')).toEqual(['eq', 'profile_id', 'p1'])
    expect(op(call, 'or')).toEqual(['or', 'kind.eq.weekly,end_date.gte.2026-09-25'])
  })
  it('a failed read is an error, never an empty availability', async () => {
    const db = fakeDb({ staff_unavailability: () => ({ data: null, error: { message: 'down' } }) })
    expect(await readOwnAvailability(db, 'p1', '2026-09-25')).toEqual({ data: null, error: { message: 'down' } })
  })
})

describe('saveOwnAvailability', () => {
  it('calls the RPC with the canonical lists and returns its answer', async () => {
    let args = null
    const db = fakeDb({}, async (name, a) => {
      args = { name, ...a }
      return { data: { changed: true, change_id: 'c1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: true }] }, error: null }
    })
    const weekly = [{ kind: 'weekly', weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null }]
    const { result, error } = await saveOwnAvailability(db, { profileId: 'p1', actorId: 'm1', todayIso: '2026-09-25', weekly, dated: [] })
    expect(error).toBeNull()
    expect(args).toEqual({ name: 'replace_staff_unavailability', p_profile_id: 'p1', p_actor_id: 'm1', p_today: '2026-09-25', p_weekly: weekly, p_dated: [] })
    expect(result).toEqual({ changed: true, changeId: 'c1', before: [], after: [{ kind: 'weekly', weekday: 'mon', all_day: true }] })
  })
  it('passes the RPC error through', async () => {
    const db = fakeDb({}, async () => ({ data: null, error: { code: 'P0001', message: 'availability_past_date: …' } }))
    const { result, error } = await saveOwnAvailability(db, { profileId: 'p1', actorId: 'p1', todayIso: '2026-09-25', weekly: [], dated: [] })
    expect(result).toBeNull()
    expect(isAvailabilityInputError(error)).toBe(true)
  })
  it.each([
    [{ code: '23514', message: 'violates check constraint' }, true],
    [{ code: '22007', message: 'invalid input syntax for type time' }, true],
    [{ code: 'P0001', message: 'availability_no_profile: …' }, true],
    [{ code: '42P01', message: 'relation does not exist' }, false],
    [{ code: '23503', message: 'fk' }, false],
    [null, false],
  ])('isAvailabilityInputError(%j) → %s', (err, expected) => expect(isAvailabilityInputError(err)).toBe(expected))
})

describe('readStudioAvailability', () => {
  const links = [
    { profile_id: 'c1', profiles: { id: 'c1', active: true, deleted_at: null } },
    { profile_id: 'c2', profiles: { id: 'c2', active: false, deleted_at: null } },
    { profile_id: 'c3', profiles: { id: 'c3', active: null, deleted_at: null } }, // NULL counts as active (mig 626)
  ]
  it("reads that studio's ACTIVE members, then their weekly rules and the dated rules overlapping the range", async () => {
    const db = fakeDb({
      profile_locations: () => ({ data: links, error: null }),
      staff_unavailability: () => ({
        data: [{ id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00:00', end_time: '11:00:00', note: 'School run' }],
        error: null,
      }),
    })
    const { data, error } = await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' }])
    const [members, rules] = db.calls
    expect(op(members, 'eq')).toEqual(['eq', 'location_id', 'L1'])
    expect(op(rules, 'in')).toEqual(['in', 'profile_id', ['c1', 'c3']])
    expect(op(rules, 'or')).toEqual(['or', 'kind.eq.weekly,and(start_date.lte.2026-05-10,end_date.gte.2026-05-04)'])
    expect(op(rules, 'range')).toEqual(['range', 0, 999])
  })
  it('pages past 1,000 rules', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, profile_id: 'c1', kind: 'weekly', weekday: 'mon', all_day: true }))
    let n = 0
    const db = fakeDb({
      profile_locations: () => ({ data: links, error: null }),
      staff_unavailability: () => ({ data: n++ === 0 ? page : [page[0]], error: null }),
    })
    const { data } = await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })
    expect(data).toHaveLength(1001)
  })
  it('no members is an empty list, with no rules read', async () => {
    const db = fakeDb({ profile_locations: () => ({ data: [], error: null }) })
    expect(await readStudioAvailability(db, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).toEqual({ data: [], error: null })
    expect(db.calls).toHaveLength(1)
  })
  it('a failed member read or rule read is an error, never "nobody is unavailable"', async () => {
    const down = { message: 'down' }
    const a = fakeDb({ profile_locations: () => ({ data: null, error: down }) })
    expect((await readStudioAvailability(a, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).error).toBe(down)
    const b = fakeDb({ profile_locations: () => ({ data: links, error: null }), staff_unavailability: () => ({ data: null, error: down }) })
    expect((await readStudioAvailability(b, { locationId: 'L1', startDate: '2026-05-04', endDate: '2026-05-10' })).error).toBe(down)
  })
})
