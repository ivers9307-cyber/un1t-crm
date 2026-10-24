import { describe, it, expect } from 'vitest'
import { registrationPaidCents, cancelRaceRegistration, moveRegistrationWave, countPlacedInto, placedSolosRefusal } from './race-cancel.js'
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

// FINDTEAM.9 — a team entry that solos were placed into cannot be cancelled:
// their rows point at it. The count runs on the service role inside the lib, so
// Mia's cancel and the approvals route inherit the refusal.
describe('cancelRaceRegistration refuses a team with placed solos (FINDTEAM.9)', () => {
  const cancelDb = ({ reg, placedCount = 0, placedErr = null }) => fakeDb((q) => {
    if (q.table !== 'race_registrations' || q.action !== 'select') return { data: null, error: null }
    if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'placed_into_registration_id')) return { data: null, count: placedCount, error: placedErr }
    return { data: reg, error: null }
  })
  const updates = (db) => db.queries.filter((x) => x.action === 'update')

  it('answers has_placed_solos with the count and writes nothing', async () => {
    const db = cancelDb({ reg: { id: 'team', status: 'confirmed' }, placedCount: 2 })
    expect(await cancelRaceRegistration(db, 'team')).toEqual({ ok: false, error: 'has_placed_solos', placedCount: 2 })
    expect(updates(db)).toHaveLength(0)
    const count = db.queries.find((x) => x.ops.some((o) => o[0] === 'eq' && o[1] === 'placed_into_registration_id'))
    expect(count.ops[0]).toEqual(['select', 'id', { count: 'exact', head: true }])
    expect(count.ops).toContainEqual(['eq', 'placed_into_registration_id', 'team'])
  })

  it('an unreadable count refuses too: an unknown answer never cancels', async () => {
    const db = cancelDb({ reg: { id: 'team', status: 'confirmed' }, placedErr: { message: 'boom' } })
    expect(await cancelRaceRegistration(db, 'team')).toEqual({ ok: false, error: 'boom' })
    expect(updates(db)).toHaveLength(0)
  })

  it('a team nobody was placed into still cancels', async () => {
    const db = cancelDb({ reg: { id: 'team', status: 'confirmed' }, placedCount: 0 })
    expect(await cancelRaceRegistration(db, 'team')).toEqual({ ok: true })
    expect(updates(db)).toHaveLength(1)
  })

  it('a cancelled row answers already_cancelled before any count', async () => {
    const db = cancelDb({ reg: { id: 'team', status: 'cancelled' }, placedCount: 2 })
    expect(await cancelRaceRegistration(db, 'team')).toEqual({ ok: true, alreadyCancelled: true })
    expect(db.queries).toHaveLength(1)
  })

  it('countPlacedInto returns the count, or the error', async () => {
    expect(await countPlacedInto(cancelDb({ placedCount: 3 }), 'team')).toEqual({ count: 3 })
    expect(await countPlacedInto(cancelDb({ placedCount: null }), 'team')).toEqual({ count: 0 })
    expect(await countPlacedInto(cancelDb({ placedErr: { message: 'x' } }), 'team')).toEqual({ error: 'x' })
  })

  it('placedSolosRefusal is the one 409 body the DELETE and cancel routes share', () => {
    expect(placedSolosRefusal(1, 'cancelled')).toEqual({
      success: false,
      error: 'has_placed_solos',
      message: '1 placed entrant points at this team; un-place them first. There is no un-place tool in the CRM yet, so this team cannot be cancelled from here.',
      placed_count: 1,
    })
    expect(placedSolosRefusal(2, 'deleted').message).toMatch(/^2 placed entrants point at this team; un-place them first\./)
    expect(placedSolosRefusal(2, 'deleted').message).toMatch(/cannot be deleted from here\.$/)
  })
})
