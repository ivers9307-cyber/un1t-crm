import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/scheduler'
import { paymentTroubleKind } from '@/lib/churn-radar'
import { maybeEnrolDunning, exitDunningForContact } from './dunning.js'

vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/sequences/scheduler', () => ({ setEnrollmentStatus: vi.fn() }))
vi.mock('@/lib/churn-radar', () => ({ paymentTroubleKind: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

function fakeDb({ location = {}, sequence = null, contact = {}, enrollments = [] } = {}) {
  return {
    from(table) {
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: location, error: null }) }) }) }
      }
      if (table === 'email_sequences') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: sequence, error: null }) }) }) }
      }
      if (table === 'contacts') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: contact, error: null }) }) }) }
      }
      if (table === 'sequence_enrollments') {
        const chain = { eq: () => chain, then: (r) => r({ data: enrollments, error: null }) }
        return { select: () => chain }
      }
      return {}
    },
  }
}

const ACTIVE_SEQ = { id: 'seq1', name: 'Dunning', status: 'active', location_id: 'loc', trigger_type: 'manual' }

beforeEach(() => {
  vi.mocked(enrolContacts).mockReset()
  vi.mocked(setEnrollmentStatus).mockReset()
  vi.mocked(paymentTroubleKind).mockReset()
})

describe('maybeEnrolDunning', () => {
  it('skips when auto-enroll is off (default)', async () => {
    const db = fakeDb({ location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: false } })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', {})).toEqual({ enrolled: 0, reason: 'auto_enroll_off' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when no dunning sequence is configured', async () => {
    const db = fakeDb({ location: { dunning_auto_enroll: true } })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', {})).toMatchObject({ enrolled: 0, reason: 'no_dunning_sequence' })
  })

  it('skips when the sequence is paused/unavailable', async () => {
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: { ...ACTIVE_SEQ, status: 'paused' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', {})).toMatchObject({ enrolled: 0, reason: 'sequence_unavailable' })
  })

  it('never duns a paused member', async () => {
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'paused' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', {})).toMatchObject({ enrolled: 0, reason: 'member_paused' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when the member is not actually behind', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue(null)
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', {})).toMatchObject({ enrolled: 0, reason: 'not_behind' })
  })

  it('enrols a behind, non-paused member when auto-enroll is on', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    vi.mocked(enrolContacts).mockResolvedValue({ enrolled: 1, skipped: 0 })
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    const out = await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv9' })
    expect(out).toMatchObject({ enrolled: 1, kind: 'overdue', sequence_id: 'seq1' })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv9',
    })
  })
})

describe('exitDunningForContact', () => {
  it('no-op when no dunning sequence configured', async () => {
    const db = fakeDb({ location: {} })
    expect(await exitDunningForContact(db, 'loc', 'c1', 'invoice_paid')).toEqual({ exited: 0 })
    expect(setEnrollmentStatus).not.toHaveBeenCalled()
  })

  it('no-op when nothing is active', async () => {
    const db = fakeDb({ location: { dunning_sequence_id: 'seq1' }, enrollments: [] })
    expect(await exitDunningForContact(db, 'loc', 'c1', 'invoice_paid')).toEqual({ exited: 0 })
  })

  it('exits each active enrolment with the reason', async () => {
    vi.mocked(setEnrollmentStatus).mockResolvedValue(undefined)
    const db = fakeDb({ location: { dunning_sequence_id: 'seq1' }, enrollments: [{ id: 'e1' }, { id: 'e2' }] })
    expect(await exitDunningForContact(db, 'loc', 'c1', 'invoice_paid')).toEqual({ exited: 2 })
    expect(setEnrollmentStatus).toHaveBeenCalledWith({ enrollmentId: 'e1', status: 'exited', reason: 'invoice_paid' })
    expect(setEnrollmentStatus).toHaveBeenCalledWith({ enrollmentId: 'e2', status: 'exited', reason: 'invoice_paid' })
  })
})
