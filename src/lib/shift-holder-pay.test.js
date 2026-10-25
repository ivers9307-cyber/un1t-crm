// CONTRACTORSPEND.1 — pay is read for the people who HOLD shifts, never for a
// studio's member list: type from profiles by named columns, pay from
// profile_compensation (mig 152's canonical copy). A failed read throws.
import { describe, it, expect } from 'vitest'
import { loadHolderPay, liveHolderIds } from './shift-holder-pay'

function fakeDb({ profiles = [], comp = [], fail = {} } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const q = { table, select: null, col: null, ids: null }
      reads.push(q)
      const chain = {
        select(s) { q.select = s; return chain },
        in(col, ids) { q.col = col; q.ids = ids; return chain },
        then(res, rej) {
          let out
          if (fail[table]) out = { data: null, error: { message: `${table} unreadable` } }
          else if (table === 'profiles') out = { data: profiles.filter((p) => q.ids.includes(p.id)), error: null }
          else if (table === 'profile_compensation') out = { data: comp.filter((c) => q.ids.includes(c.profile_id)), error: null }
          else out = { data: null, error: { message: `unexpected table ${table}` } }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('liveHolderIds', () => {
  it('lists each live holder once, skipping cancelled rows and missing ids', () => {
    const blocks = [
      { shift_assignments: [{ profile_id: 'a', status: 'scheduled' }, { profile_id: 'b', status: 'cancelled' }] },
      { shift_assignments: [{ profile_id: 'a', status: 'swapped' }, { profile_id: null }, { profile_id: 'c' }] },
      { shift_assignments: null },
    ]
    expect(liveHolderIds(blocks)).toEqual(['a', 'c'])
    expect(liveHolderIds(null)).toEqual([])
  })
})

describe('loadHolderPay', () => {
  it('takes the type from profiles and the pay from profile_compensation', async () => {
    const db = fakeDb({
      // hourly_rate on profiles is the DEPRECATED copy: it must never be used.
      profiles: [{ id: 'dan', employment_type: 'contractor', hourly_rate: 999 }, { id: 'sam', employment_type: 'fte' }],
      comp: [
        { profile_id: 'dan', hourly_rate: '35.00', annual_salary: null, contracted_hours_per_week: null },
        { profile_id: 'sam', hourly_rate: null, annual_salary: '39000', contracted_hours_per_week: '30' },
      ],
    })
    const pay = await loadHolderPay(db, ['dan', 'sam', 'dan'])
    expect(pay.get('dan')).toEqual({ employment_type: 'contractor', hourly_rate: 35, annual_salary: null, contracted_hours_per_week: null })
    expect(pay.get('sam')).toEqual({ employment_type: 'fte', hourly_rate: null, annual_salary: 39000, contracted_hours_per_week: 30 })
    expect(db.reads.find((q) => q.table === 'profiles').select).toBe('id, employment_type')
  })

  it('a holder with no compensation row has null pay; a holder with no profile row is absent', async () => {
    const db = fakeDb({ profiles: [{ id: 'new', employment_type: 'contractor' }] })
    const pay = await loadHolderPay(db, ['new', 'ghost'])
    expect(pay.get('new')).toEqual({ employment_type: 'contractor', hourly_rate: null, annual_salary: null, contracted_hours_per_week: null })
    expect(pay.has('ghost')).toBe(false)
  })

  it('no ids = no reads', async () => {
    const db = fakeDb()
    expect((await loadHolderPay(db, [])).size).toBe(0)
    expect((await loadHolderPay(db, null)).size).toBe(0)
    expect(db.reads).toEqual([])
  })

  it('chunks the id list at 200 (URL length)', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`)
    const db = fakeDb({ profiles: ids.map((id) => ({ id, employment_type: 'contractor' })) })
    const pay = await loadHolderPay(db, ids)
    expect(pay.size).toBe(201)
    expect(db.reads.filter((q) => q.table === 'profiles').map((q) => q.ids.length)).toEqual([200, 1])
  })

  for (const table of ['profiles', 'profile_compensation']) {
    it(`a failed ${table} read throws (never "nobody is paid")`, async () => {
      const db = fakeDb({ profiles: [{ id: 'dan', employment_type: 'contractor' }], fail: { [table]: true } })
      await expect(loadHolderPay(db, ['dan'])).rejects.toThrow(/unreadable/)
    })
  }
})
