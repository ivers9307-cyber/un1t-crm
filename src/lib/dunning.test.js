import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/scheduler'
import { paymentTroubleKind } from '@/lib/churn-radar'
import { maybeEnrolDunning, exitDunningForContact, dunningActionFor } from './dunning.js'

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
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })).toEqual({ enrolled: 0, reason: 'auto_enroll_off' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when no dunning sequence is configured', async () => {
    const db = fakeDb({ location: { dunning_auto_enroll: true } })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })).toMatchObject({ enrolled: 0, reason: 'no_dunning_sequence' })
  })

  it('skips when the sequence is paused/unavailable', async () => {
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: { ...ACTIVE_SEQ, status: 'paused' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })).toMatchObject({ enrolled: 0, reason: 'sequence_unavailable' })
  })

  it('never duns a paused member', async () => {
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'paused' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })).toMatchObject({ enrolled: 0, reason: 'member_paused' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when the member is not actually behind', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue(null)
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })).toMatchObject({ enrolled: 0, reason: 'not_behind' })
  })

  it('enrols a behind, non-paused member when auto-enroll is on', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    vi.mocked(enrolContacts).mockResolvedValue({ enrolled: 1, skipped: 0 })
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    const out = await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv9', isMembership: true })
    expect(out).toMatchObject({ enrolled: 1, kind: 'overdue', sequence_id: 'seq1' })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv9', allowReenrol: true,
    })
  })

  it('DUNNING.1 — never enrols for a non-membership invoice (a fee / class pack / custom charge), and fails closed when the flag is missing', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'fee1', isMembership: false })).toEqual({ enrolled: 0, reason: 'not_membership_invoice' })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'fee1' })).toEqual({ enrolled: 0, reason: 'not_membership_invoice' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('DUNNING.1 — a failed membership invoice enrols as a transactional, re-runnable dunning enrolment', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    vi.mocked(enrolContacts).mockResolvedValue({ enrolled: 1, skipped: 0, reactivated: 0 })
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    const res = await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv-renewal', isMembership: true })
    expect(res).toMatchObject({ enrolled: 1, sequence_id: 'seq1' })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv-renewal', allowReenrol: true,
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

describe('dunningActionFor (DUNNING.1) — the webhook decision', () => {
  it('enrols on a failed MEMBERSHIP invoice only', () => {
    expect(dunningActionFor('PAST_DUE', true)).toBe('enrol')
    expect(dunningActionFor('PAST_DUE', false)).toBeNull()
    expect(dunningActionFor('PAST_DUE', undefined)).toBeNull()
  })
  it('exits on a settled MEMBERSHIP invoice only — a paid fee never cancels a reminder run', () => {
    expect(dunningActionFor('PAID', true)).toBe('exit')
    expect(dunningActionFor('FORGIVEN', true)).toBe('exit')
    expect(dunningActionFor('PAID', false)).toBeNull()
    expect(dunningActionFor('FORGIVEN', false)).toBeNull()
  })
  it('ignores every other status and is case-insensitive', () => {
    expect(dunningActionFor('PENDING', true)).toBeNull()
    expect(dunningActionFor('CANCELLED', true)).toBeNull()
    expect(dunningActionFor('past_due', true)).toBe('enrol')
    expect(dunningActionFor(null, true)).toBeNull()
  })
})
