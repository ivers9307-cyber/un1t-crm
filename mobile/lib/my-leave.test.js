// LEAVEPHONE.1 — the My leave list. Pure; the screen only renders it.
import { describe, it, expect } from 'vitest'
import { myLeaveRow, myLeaveSections, MY_LEAVE_EMPTY, MY_LEAVE_CANCEL_CONFIRM } from './my-leave'

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

describe('copy', () => {
  it('is plain and has no em dash', () => {
    for (const s of [MY_LEAVE_EMPTY, MY_LEAVE_CANCEL_CONFIRM.title, MY_LEAVE_CANCEL_CONFIRM.message, MY_LEAVE_CANCEL_CONFIRM.confirm, MY_LEAVE_CANCEL_CONFIRM.keep]) {
      expect(typeof s).toBe('string')
      expect(s).not.toContain('—')
    }
  })
})
