import { describe, it, expect } from 'vitest'
import { readAvailabilityLeave, withAvailabilityLeave } from './availability-leave'

// Fictional ids only: the repo is public.

// A fake supabase client: records every call on the chain and answers each
// .range() with the next scripted page for that table.
function fakeDb(pages = {}) {
  const calls = []
  const left = Object.fromEntries(Object.entries(pages).map(([t, p]) => [t, [...p]]))
  return {
    calls,
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const chain = {}
      for (const op of ['select', 'in', 'eq', 'lte', 'gte', 'order']) {
        chain[op] = (...args) => { call.ops.push([op, ...args]); return chain }
      }
      chain.range = (...args) => {
        call.ops.push(['range', ...args])
        const next = (left[table] || []).shift()
        return Promise.resolve(next instanceof Error ? { data: null, error: { message: next.message } } : { data: next || [], error: null })
      }
      return chain
    },
  }
}

const rule = (id, over = {}) => ({
  id, profile_id: 'p-1', kind: 'dated', start_date: '2026-10-11', end_date: '2026-10-11', all_day: true, note: null, ...over,
})

describe('readAvailabilityLeave', () => {
  it('reads all-day dated rules overlapping the range for these people, as leave rows', async () => {
    const db = fakeDb({ staff_unavailability: [[rule('a'), rule('b', { all_day: false, start_time: '06:00', end_time: '07:00' })]] })
    const { rows, error } = await readAvailabilityLeave(db, { profileIds: ['p-1', 'p-1', null], startDate: '2026-10-01', endDate: '2026-10-31' })
    expect(error).toBeNull()
    // The part-day rule is dropped even if the database returned it.
    expect(rows.map((r) => [r.id, r.type, r.status, r.source])).toEqual([['availability:a', 'unavailable', 'approved', 'availability']])
    const ops = db.calls[0].ops
    expect(db.calls[0].table).toBe('staff_unavailability')
    expect(ops).toContainEqual(['in', 'profile_id', ['p-1']])
    expect(ops).toContainEqual(['eq', 'kind', 'dated'])
    expect(ops).toContainEqual(['eq', 'all_day', true])
    expect(ops).toContainEqual(['lte', 'start_date', '2026-10-31'])
    expect(ops).toContainEqual(['gte', 'end_date', '2026-10-01'])
  })

  it('reads nothing for nobody', async () => {
    const db = fakeDb()
    expect(await readAvailabilityLeave(db, { profileIds: [], startDate: '2026-10-01', endDate: '2026-10-31' })).toEqual({ rows: [], error: null })
    expect(db.calls).toEqual([])
  })

  it('pages past 1,000 rows', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => rule(`r${i}`))
    const db = fakeDb({ staff_unavailability: [full, [rule('last')]] })
    const { rows } = await readAvailabilityLeave(db, { profileIds: ['p-1'], startDate: '2026-10-01', endDate: '2026-10-31' })
    expect(rows).toHaveLength(1001)
    expect(db.calls).toHaveLength(2)
  })

  it('a failed read is an error with NO rows, never "nobody is unavailable"', async () => {
    const db = fakeDb({ staff_unavailability: [new Error('boom')] })
    const res = await readAvailabilityLeave(db, { profileIds: ['p-1'], startDate: '2026-10-01', endDate: '2026-10-31' })
    expect(res.rows).toBeNull()
    expect(res.error).toEqual({ message: 'boom' })
  })
})

describe('withAvailabilityLeave', () => {
  it('appends the availability rows to the leave rows', async () => {
    const db = fakeDb({ staff_unavailability: [[rule('a')]] })
    const leave = [{ id: 't-1', profile_id: 'p-1', type: 'holiday', status: 'approved', start_date: '2026-10-02', end_date: '2026-10-02' }]
    const { rows, error } = await withAvailabilityLeave(db, leave, { profileIds: ['p-1'], startDate: '2026-10-01', endDate: '2026-10-31' })
    expect(error).toBeNull()
    expect(rows.map((r) => r.id)).toEqual(['t-1', 'availability:a'])
  })

  it('on a failed read returns the leave rows AND the error, so each caller applies its own policy', async () => {
    const db = fakeDb({ staff_unavailability: [new Error('boom')] })
    const leave = [{ id: 't-1' }]
    const { rows, error } = await withAvailabilityLeave(db, leave, { profileIds: ['p-1'], startDate: '2026-10-01', endDate: '2026-10-31' })
    expect(rows).toEqual(leave)
    expect(error).toEqual({ message: 'boom' })
  })
})
