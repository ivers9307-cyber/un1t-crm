// LEAVEPHONE.1 — the My leave list. Pure; the screen only renders it.
import { describe, it, expect } from 'vitest'
import {
  myLeaveRow, myLeaveSections, MY_LEAVE_EMPTY, MY_LEAVE_CANCEL_CONFIRM,
  stillCancellable, myLeaveCancelOutcome, MY_LEAVE_NO_LONGER_PENDING,
  myLeaveWithdrawOutcome, MY_LEAVE_CANCEL_REQUESTED, MY_LEAVE_CANCEL_SENT_TO_OWNER, MY_LEAVE_WITHDRAW_CONFIRM,
} from './my-leave'

const ME = { id: 'me' }
const row = (id, status, start, extra = {}) => ({
  id, profile_id: 'me', type: 'holiday', status, effective_status: status,
  start_date: start, end_date: start, total_days: 1, reason: null, review_note: null, reviewer: null, ...extra,
})

describe('myLeaveRow', () => {
  it('carries the label, range, days, status and the manager\'s note', () => {
    expect(myLeaveRow(row('r1', 'rejected', '2026-10-05', {
      end_date: '2026-10-09', total_days: 5, review_note: 'Two others are already off that week.', reviewer: { id: 'm', full_name: 'Manager One' },
    }), ME)).toEqual({
      id: 'r1', title: 'Holiday', range: 'Mon 5 Oct – Fri 9 Oct', summary: 'Mon 5 Oct – Fri 9 Oct · 5 days', days: 5,
      status: 'rejected', statusLabel: 'Declined', tone: 'red',
      reason: null, note: 'Two others are already off that week.', noteHeading: 'Note from Manager One', canCancel: false,
      cancelNote: null, canWithdrawCancel: false,
    })
  })
  it('a note with no reviewer name still gets a heading; no note, no heading', () => {
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05', { review_note: 'Enjoy.' }), ME).noteHeading).toBe('Manager’s note')
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05'), ME).noteHeading).toBeNull()
  })
  it('one day is singular', () => {
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05'), ME).summary).toBe('Mon 5 Oct · 1 day')
  })
  it('cancel is offered on the caller\'s own pending request only — the existing rule', () => {
    expect(myLeaveRow(row('r1', 'pending', '2026-10-05'), ME).canCancel).toBe(true)
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05'), ME).canCancel).toBe(false)
    expect(myLeaveRow(row('r1', 'rejected', '2026-10-05'), ME).canCancel).toBe(false)
    expect(myLeaveRow(row('r1', 'cancelled', '2026-10-05'), ME).canCancel).toBe(false)
    expect(myLeaveRow(row('r1', 'pending', '2026-10-05', { profile_id: 'other' }), ME).canCancel).toBe(false)
  })
  it('an expired pending request reads Expired and offers no Cancel', () => {
    const r = myLeaveRow(row('r1', 'pending', '2026-03-02', { effective_status: 'expired' }), ME)
    expect(r).toMatchObject({ status: 'expired', statusLabel: 'Expired', tone: 'slate', canCancel: false })
  })
  // LEAVECANCEL.1 — approved leave whose cancellation is waiting for an owner
  // is STILL approved: same chip, same section, plus a line saying so. The
  // flags are the server's (GET /api/schedule/time-off); the phone re-decides
  // nothing.
  it('an open cancellation request keeps the row Approved, says it is waiting, and offers Withdraw when the server says so', () => {
    const r = myLeaveRow(row('r1', 'approved', '2026-10-05', { cancel_request_state: 'open', can_withdraw_cancel: true }), ME)
    expect(r).toMatchObject({ status: 'approved', statusLabel: 'Approved', canCancel: false, cancelNote: MY_LEAVE_CANCEL_REQUESTED, canWithdrawCancel: true })
  })
  it('Withdraw is never offered on someone else\'s row, whatever the flags say', () => {
    const r = myLeaveRow(row('r1', 'approved', '2026-10-05', { profile_id: 'other', cancel_request_state: 'open', can_withdraw_cancel: true }), ME)
    expect(r.canWithdrawCancel).toBe(false)
  })
  it('a declined cancellation says the leave stays approved, with the owner\'s note', () => {
    const r = myLeaveRow(row('r1', 'approved', '2026-10-05', { cancel_request_state: 'rejected', cancel_decision_note: 'We are short that week' }), ME)
    expect(r.cancelNote).toBe('Cancellation declined. Your leave stays approved. "We are short that week"')
    expect(r.canWithdrawCancel).toBe(false)
  })
  it('leave cancelled at the person\'s own request says so, and who approved it', () => {
    const done = row('r1', 'cancelled', '2026-10-05', { cancel_request_state: 'approved', cancel_decision: 'approved', cancel_decider: { full_name: 'Olive Owner' } })
    expect(myLeaveRow(done, ME).cancelNote).toBe('Cancelled at your request, approved by Olive Owner.')
    expect(myLeaveRow({ ...done, cancel_decider: null }, ME).cancelNote).toBe('Cancelled at your request, approved by an owner.')
    expect(myLeaveRow(row('r1', 'cancelled', '2026-10-05'), ME).cancelNote).toBeNull()
  })
  it('a row from a deployment that predates LEAVECANCEL.1 carries no flags and reads exactly as before', () => {
    expect(myLeaveRow(row('r1', 'approved', '2026-10-05'), ME)).toMatchObject({ cancelNote: null, canWithdrawCancel: false })
  })

  it('a row from an older deployment with no effective_status falls back to its raw status', () => {
    const r = row('r1', 'approved', '2026-10-05'); delete r.effective_status
    expect(myLeaveRow(r, ME)).toMatchObject({ status: 'approved', statusLabel: 'Approved', tone: 'green' })
  })
})

describe('myLeaveSections', () => {
  it('groups by status in a fixed order, drops empty groups and other people\'s rows', () => {
    const sections = myLeaveSections([
      row('c1', 'cancelled', '2026-05-04'),
      row('a2', 'approved', '2026-11-02'),
      row('p1', 'pending', '2026-10-05'),
      row('a1', 'approved', '2026-10-12'),
      row('x', 'pending', '2026-10-05', { profile_id: 'someone-else' }),
    ], ME)
    expect(sections.map((s) => [s.key, s.title, s.rows.map((r) => r.id)])).toEqual([
      ['pending', 'Pending', ['p1']],
      ['approved', 'Approved', ['a1', 'a2']],
      ['cancelled', 'Cancelled', ['c1']],
    ])
  })
  it('open groups run soonest-first; closed groups run most-recent-first', () => {
    const sections = myLeaveSections([
      row('r-old', 'rejected', '2026-02-02'), row('r-new', 'rejected', '2026-08-03'),
    ], ME)
    expect(sections[0].rows.map((r) => r.id)).toEqual(['r-new', 'r-old'])
  })
  it('every row lands in exactly one section, an unknown status included', () => {
    const rows = [row('p', 'pending', '2026-10-05'), row('odd', 'mystery', '2026-10-06', { effective_status: 'mystery' })]
    const ids = myLeaveSections(rows, ME).flatMap((s) => s.rows.map((r) => r.id))
    expect(ids.sort()).toEqual(['odd', 'p'])
  })
  it('tolerates null and a missing profile', () => {
    expect(myLeaveSections(null, ME)).toEqual([])
    expect(myLeaveSections([row('p', 'pending', '2026-10-05')], null)).toEqual([])
  })
})

describe('stillCancellable — re-checked against a FRESH list just before the PUT', () => {
  it('true only while the row is still the caller\'s own raw-pending request', () => {
    expect(stillCancellable([row('r1', 'pending', '2026-10-05')], 'r1', ME)).toBe(true)
    // A manager decided it while the list sat on screen: do not send the cancel.
    expect(stillCancellable([row('r1', 'approved', '2026-10-05')], 'r1', ME)).toBe(false)
    expect(stillCancellable([row('r1', 'rejected', '2026-10-05')], 'r1', ME)).toBe(false)
    expect(stillCancellable([row('r1', 'pending', '2026-10-05', { profile_id: 'other' })], 'r1', ME)).toBe(false)
    expect(stillCancellable([], 'r1', ME)).toBe(false)
    expect(stillCancellable(null, 'r1', ME)).toBe(false)
  })
})

describe('myLeaveCancelOutcome', () => {
  it('success says nothing: the redrawn list is the confirmation', () => {
    expect(myLeaveCancelOutcome({ success: true, data: {} })).toBeNull()
  })
  it('a refusal shows the SERVER\'s words', () => {
    expect(myLeaveCancelOutcome({ success: false, status: 403, error: 'You can only cancel your own pending requests' }))
      .toEqual({ title: 'Couldn’t cancel', message: 'You can only cancel your own pending requests' })
  })
  it('no message, or no answer at all, still says something', () => {
    expect(myLeaveCancelOutcome({ success: false })).toEqual({ title: 'Couldn’t cancel', message: 'Unknown error' })
    expect(myLeaveCancelOutcome(undefined)).toEqual({ title: 'Couldn’t cancel', message: 'Unknown error' })
  })
  // LEAVECANCEL.1 — a manager's cancel that lands just after the request was
  // approved is answered { success: true, cancellation: 'requested' }: nothing
  // was cancelled, an owner was asked. Saying nothing would read as "cancelled".
  it('success with cancellation: requested is NOT a cancel: say an owner was asked', () => {
    expect(myLeaveCancelOutcome({ success: true, data: {}, cancellation: 'requested' })).toEqual(MY_LEAVE_CANCEL_SENT_TO_OWNER)
  })
  it('withdraw: null when it worked, the server\'s words when it did not', () => {
    expect(myLeaveWithdrawOutcome({ success: true, cancellation: 'withdrawn' })).toBeNull()
    expect(myLeaveWithdrawOutcome({ success: false, error: 'An owner decided this a moment ago' })).toEqual({ title: 'Couldn’t withdraw', message: 'An owner decided this a moment ago' })
  })
})

describe('copy', () => {
  it('is plain and has no em dash', () => {
    for (const s of [MY_LEAVE_CANCEL_REQUESTED, MY_LEAVE_CANCEL_SENT_TO_OWNER.title, MY_LEAVE_CANCEL_SENT_TO_OWNER.message, MY_LEAVE_WITHDRAW_CONFIRM.title, MY_LEAVE_WITHDRAW_CONFIRM.message, MY_LEAVE_WITHDRAW_CONFIRM.confirm, MY_LEAVE_WITHDRAW_CONFIRM.keep, MY_LEAVE_EMPTY, MY_LEAVE_NO_LONGER_PENDING.title, MY_LEAVE_NO_LONGER_PENDING.message, MY_LEAVE_CANCEL_CONFIRM.title, MY_LEAVE_CANCEL_CONFIRM.message, MY_LEAVE_CANCEL_CONFIRM.confirm, MY_LEAVE_CANCEL_CONFIRM.keep]) {
      expect(typeof s).toBe('string')
      expect(s).not.toContain('—')
    }
  })
})
