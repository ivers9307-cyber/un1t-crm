import { describe, it, expect } from 'vitest'
import { registrationPaidCents, cancelRaceRegistration, moveRegistrationWave } from './race-cancel.js'
import { fakeDb } from './event-waitlist.test-helpers'

// db.from('race_payments')…limit(n) -> { data: rows }; no placed-into rows.
function mockDb(rows) {
  return fakeDb((q) => (q.table === 'race_payments' ? { data: rows, error: null } : { data: [], error: null }))
}

describe('registrationPaidCents', () => {
  // Regression: the filter used to compare status === 'paid', but the
  // race_payments CHECK constraint forbids 'paid' — free + Revolut-completed
  // entries both store 'completed'. So it always summed an empty set and
  // returned 0, which made Mia auto-cancel PAID race entries (action 'direct')
  // instead of routing them to the human refund-approval queue (action 'draft').
  it('sums only completed payments', async () => {
    const db = mockDb([
      { amount_cents: 1000, status: 'completed' },
      { amount_cents: 500, status: 'completed' },
      { amount_cents: 999, status: 'pending' },
      { amount_cents: 999, status: 'failed' },
      { amount_cents: 999, status: 'refunded' },
      { amount_cents: 999, status: 'abandoned' },
    ])
    expect(await registrationPaidCents(db, 'reg1')).toBe(1500)
  })

  it('is case-insensitive on status', async () => {
    const db = mockDb([{ amount_cents: 2500, status: 'COMPLETED' }])
    expect(await registrationPaidCents(db, 'reg1')).toBe(2500)
  })

  it('returns 0 when there are no completed rows', async () => {
    const db = mockDb([{ amount_cents: 1000, status: 'pending' }])
    expect(await registrationPaidCents(db, 'reg1')).toBe(0)
  })

  it('returns 0 on an empty / null result', async () => {
    expect(await registrationPaidCents(mockDb([]), 'reg1')).toBe(0)
    expect(await registrationPaidCents(mockDb(null), 'reg1')).toBe(0)
  })
})

// FINDTEAM.8 (I3) — payments of solos placed INTO a team count as the team's.
describe('registrationPaidCents — placed-into solos', () => {
  it("sums the completed payments of registrations placed into this one", async () => {
    const pays = { team: [{ amount_cents: 0, status: 'completed' }], s1: [{ amount_cents: 2000, status: 'completed' }], s2: [{ amount_cents: 2000, status: 'abandoned' }] }
    const db = fakeDb((q) => {
      if (q.table === 'race_registrations') return { data: [{ id: 's1' }, { id: 's2' }], error: null }
      const ids = q.ops.find((o) => o[0] === 'in' && o[1] === 'race_registration_id')[2]
      return { data: ids.flatMap((id) => pays[id] || []), error: null }
    })
    expect(await registrationPaidCents(db, 'team')).toBe(2000)
    const placed = db.queries.find((x) => x.table === 'race_registrations')
    expect(placed.ops).toContainEqual(['eq', 'placed_into_registration_id', 'team'])
    const payQ = db.queries.find((x) => x.table === 'race_payments')
    expect(payQ.ops).toContainEqual(['in', 'race_registration_id', ['team', 's1', 's2']])
  })

  it('throws on a failed read rather than reading as free', async () => {
    const bad1 = fakeDb((q) => (q.table === 'race_registrations' ? { data: null, error: { message: 'x' } } : { data: [], error: null }))
    await expect(registrationPaidCents(bad1, 'r')).rejects.toThrow()
    const bad2 = fakeDb((q) => (q.table === 'race_payments' ? { data: null, error: { message: 'x' } } : { data: [], error: null }))
    await expect(registrationPaidCents(bad2, 'r')).rejects.toThrow()
  })
})

describe('cancel / move refuse a placed row (FINDTEAM.8 I3)', () => {
  const regDb = (reg) => fakeDb((q) => (q.table === 'race_registrations' && q.action === 'select' ? { data: reg, error: null } : { data: null, error: null }))

  it('cancelRaceRegistration refuses placed with not_active and writes nothing', async () => {
    const db = regDb({ id: 'r1', status: 'placed' })
    expect(await cancelRaceRegistration(db, 'r1')).toEqual({ ok: false, error: 'not_active' })
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })

  it('cancelRaceRegistration still cancels a confirmed row', async () => {
    const db = regDb({ id: 'r1', status: 'confirmed' })
    expect(await cancelRaceRegistration(db, 'r1')).toEqual({ ok: true })
  })

  it('moveRegistrationWave refuses placed with not_active', async () => {
    const db = regDb({ id: 'r1', race_event_id: 'e1', status: 'placed', wave_id: 'w1' })
    expect(await moveRegistrationWave(db, 'r1', 'w2')).toEqual({ ok: false, error: 'not_active' })
    expect(db.queries.some((x) => x.table === 'race_waves' || x.action === 'update')).toBe(false)
  })
})
