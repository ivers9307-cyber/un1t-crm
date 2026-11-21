// CHECKINPAID.1 — what each person paid, on the staff door roster.
// Fictional names only.
import { describe, it, expect } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'
import { loadCheckinRoster, paidByMember } from './event-checkin-write.js'

const EVENT = 'e0000000-0000-4000-8000-000000000001'
const member = (id, name, extra = {}) => ({ id, name, email: `${name.toLowerCase()}@example.test`, contact_id: null, ...extra })
const team = (id, members) => ({ id: `t-${id}`, name: `Team ${id}`, team_members: members })

// Team A: captain Ann paid €100 for four. Solo Sam paid €25 and was placed
// into team B (made by pairing, no payment of its own). Team C is unpaid.
const REGS = [
  { id: 'rA', status: 'confirmed', wave_id: null, contact_id: 'cAnn', placed_into_registration_id: null,
    teams: team('A', [member('mBo', 'Bo'), member('mAnn', 'Ann', { contact_id: 'cAnn' }), member('mCy', 'Cy'), member('mDi', 'Di')]) },
  { id: 'rB', status: 'confirmed', wave_id: null, contact_id: null, placed_into_registration_id: null,
    teams: team('B', [member('mSamB', 'Sam', { contact_id: 'cSam' }), member('mTom', 'Tom')]) },
  { id: 'rSam', status: 'placed', wave_id: null, contact_id: 'cSam', placed_into_registration_id: 'rB',
    teams: team('Sam', [member('mSam', 'Sam', { contact_id: 'cSam' })]) },
  { id: 'rC', status: 'confirmed', wave_id: null, contact_id: null, placed_into_registration_id: null,
    teams: team('C', [member('mEd', 'Ed')]) },
]
const pay = (id, reg, cents, extra = {}) => ({ id, race_event_id: EVENT, race_registration_id: reg, amount_cents: cents, status: 'completed', currency: 'EUR', contact_email: 'x@example.test', ...extra })

describe('paidByMember', () => {
  it('puts a booking\'s payment beside the payer, for everyone on it', () => {
    const m = paidByMember(REGS, [pay('p1', 'rA', 10000, { contact_id: 'cAnn', contact_email: 'ann@example.test' })])
    expect(m.get('rA:mAnn')).toEqual({ cents: 10000, people: 4, currency: 'EUR' })
    expect(m.has('rA:mBo')).toBe(false)
  })

  it('follows a placed solo\'s payment to their name on the team they joined', () => {
    const m = paidByMember(REGS, [pay('p2', 'rSam', 2500, { contact_id: 'cSam' })])
    expect(m.get('rB:mSamB')).toEqual({ cents: 2500, people: 1, currency: 'EUR' })
    expect(m.has('rSam:mSam')).toBe(false)
  })

  it('matches the payer by email, else the booking contact, else the first name', () => {
    expect([...paidByMember(REGS, [pay('p', 'rA', 100, { contact_email: 'CY@example.test ' })]).keys()]).toEqual(['rA:mCy'])
    expect([...paidByMember(REGS, [pay('p', 'rA', 100, { contact_email: 'nobody@example.test' })]).keys()]).toEqual(['rA:mAnn'])
    const noContact = REGS.map((r) => (r.id === 'rA' ? { ...r, contact_id: null } : r))
    expect([...paidByMember(noContact, [pay('p', 'rA', 100, { contact_email: 'nobody@example.test' })]).keys()]).toEqual(['rA:mBo'])
  })

  it('adds a booking\'s payments together, less refunds, and drops a fully refunded one', () => {
    const m = paidByMember(REGS, [
      pay('p1', 'rA', 10000, { contact_id: 'cAnn' }),
      pay('p2', 'rA', 1500, { contact_id: 'cAnn', refunded_amount_cents: 500 }),
      pay('p3', 'rC', 2000, { refunded_amount_cents: 2000 }),
    ])
    expect(m.get('rA:mAnn').cents).toBe(11000)
    expect(m.has('rC:mEd')).toBe(false)
  })
})

describe('loadCheckinRoster withPaid', () => {
  const db = () => createFakeDb({
    tables: {
      race_checkins: [],
      race_payments: [
        pay('p1', 'rA', 10000, { contact_id: 'cAnn' }),
        pay('p2', 'rSam', 2500, { contact_id: 'cSam' }),
        pay('p3', 'rC', 9900, { status: 'failed' }),
        pay('p4', 'rC', 9900, { race_event_id: 'e0000000-0000-4000-8000-000000000002' }),
      ],
    },
  })

  it('stamps paid_cents on each member, completed payments of this event only', async () => {
    const { rows, error } = await loadCheckinRoster(db(), { id: EVENT, waves: [], registrations: REGS }, { withPaid: true })
    expect(error).toBeUndefined()
    const byId = Object.fromEntries(rows.flatMap((r) => r.team.team_members).map((m) => [m.id, m]))
    expect(byId.mAnn).toMatchObject({ paid_cents: 10000, paid_for: 4 })
    expect(byId.mSamB).toMatchObject({ paid_cents: 2500, paid_for: 1 })
    expect(byId.mBo.paid_cents).toBeNull()
    expect(byId.mEd.paid_cents).toBeNull()
    expect(rows.map((r) => r.id).sort()).toEqual(['rA', 'rB', 'rC'])
  })

  it('leaves money off without the option (the host roster)', async () => {
    const d = db()
    const { rows } = await loadCheckinRoster(d, { id: EVENT, waves: [], registrations: REGS })
    expect('paid_cents' in rows[0].team.team_members[0]).toBe(false)
    expect(d.calls.some((c) => c.table === 'race_payments')).toBe(false)
  })

  it('answers the error when the payments read fails', async () => {
    const d = createFakeDb({ tables: { race_checkins: [], race_payments: [] }, errors: { race_payments: { select: { message: 'boom' } } } })
    const { error } = await loadCheckinRoster(d, { id: EVENT, waves: [], registrations: REGS }, { withPaid: true })
    expect(error).toEqual({ message: 'boom' })
  })
})
