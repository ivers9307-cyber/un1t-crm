// src/lib/profile-compensation.test.js
// LABOUR.1 — the bulk pay reader must never answer "nobody is paid" on a
// failed read: a labour total built on an empty Map would read as a real €0.

import { describe, it, expect } from 'vitest'
import { getCompensationForProfiles } from './profile-compensation'

function fakeDb(result) {
  const seen = []
  return {
    seen,
    from(table) {
      const b = {}
      for (const m of ['select', 'in']) b[m] = (...args) => { seen.push([table, m, ...args]); return b }
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return b
    },
  }
}

describe('getCompensationForProfiles', () => {
  it('maps each row to numbers, keyed by profile id', async () => {
    const db = fakeDb({
      data: [{
        profile_id: 'p1', annual_salary: '36000.00', hourly_rate: null,
        contracted_hours_per_week: '39.0', annual_leave_entitlement: null, overtime_rate: null,
      }],
      error: null,
    })
    const out = await getCompensationForProfiles(db, ['p1'])
    expect(out.get('p1')).toEqual({
      annual_salary: 36000, hourly_rate: null, contracted_hours_per_week: 39,
      annual_leave_entitlement: null, overtime_rate: null,
    })
    expect(db.seen).toContainEqual(['profile_compensation', 'in', 'profile_id', ['p1']])
  })

  it('throws on a failed read instead of returning an empty map', async () => {
    const db = fakeDb({ data: null, error: { message: 'permission denied' } })
    await expect(getCompensationForProfiles(db, ['p1']))
      .rejects.toThrow('profile_compensation read failed: permission denied')
  })

  it('reads nothing for no ids', async () => {
    const db = fakeDb({ data: [], error: null })
    const out = await getCompensationForProfiles(db, [])
    expect(out.size).toBe(0)
    expect(db.seen).toEqual([])
  })
})
