// LEAVECANCEL.1 — the rules a cancellation of APPROVED leave is judged by.

import { describe, it, expect } from 'vitest'
import {
  isOpenCancelAsk, cancelAskState, selfCancelMode, canDecideLeaveCancel, leaveActingLocationIds,
  resolveLeaveCancelDeciderIds, annotateCancelAsk, cancelAskEventKey,
  cancelAskNoticeKey, reAskBlockedUntil, CLEARED_CANCEL_ASK,
  isMissingCancelSchemaError, CANCEL_ASK_OFF, dublinRetryLabel,
  requesterLeaveTier, approvedLeaveGuardAllows, annotateApprovedLeaveGuard, approvedLeaveRefusal,
} from './time-off-cancel.js'
import { LEAVE_CANCEL_NOTICES, cancelledAtRequestText } from './time-off-cancel-copy.js'
import { fakeDb, queriesOf } from './time-off.test-helpers.js'

const TODAY = '2026-09-21'
const leave = (over = {}) => ({
  id: 'req-1', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', type: 'holiday',
  start_date: '2026-10-05', end_date: '2026-10-07',
  cancel_requested_at: null, cancel_requested_by: null, cancel_decided_at: null, cancel_decision: null,
  ...over,
})
const asked = (over = {}) => leave({ cancel_requested_at: '2026-09-20T09:00:00Z', cancel_requested_by: 'mgr', ...over })

const person = (id, roles, profileRole = 'staff') => ({
  id, profileRole, locations: Object.keys(roles).map((l) => ({ id: l })), rolesByLocation: roles,
})
const MANAGER = person('mgr', { 'loc-1': 'manager' })
const HEAD_COACH = person('mgr', { 'loc-1': 'head_coach' })
const COACH = person('mgr', { 'loc-1': 'staff' })
const OWNER = person('own', { 'loc-1': 'owner' })
const OTHER_MANAGER = person('mgr-2', { 'loc-1': 'manager' })
const MASTER = person('boss', {}, 'master')

describe('isOpenCancelAsk / cancelAskState', () => {
  it('open = asked, undecided, still approved, not yet ended', () => {
    expect(isOpenCancelAsk(asked(), TODAY)).toBe(true)
    expect(cancelAskState(asked(), TODAY)).toBe('open')
  })

  it('never asked is not an ask', () => {
    expect(isOpenCancelAsk(leave(), TODAY)).toBe(false)
    expect(cancelAskState(leave(), TODAY)).toBeNull()
  })

  it('a decided ask is closed, and says which way', () => {
    const rejected = asked({ cancel_decided_at: '2026-09-20T10:00:00Z', cancel_decision: 'rejected' })
    expect(isOpenCancelAsk(rejected, TODAY)).toBe(false)
    expect(cancelAskState(rejected, TODAY)).toBe('rejected')
    const approved = asked({ status: 'cancelled', cancel_decided_at: '2026-09-20T10:00:00Z', cancel_decision: 'approved' })
    expect(cancelAskState(approved, TODAY)).toBe('approved')
  })

  it('an ask on leave that is no longer approved is moot, not open', () => {
    expect(isOpenCancelAsk(asked({ status: 'cancelled' }), TODAY)).toBe(false)
    expect(cancelAskState(asked({ status: 'cancelled' }), TODAY)).toBe('lapsed')
  })

  it('an ask lapses with the leave: open on its last day, lapsed the day after', () => {
    expect(isOpenCancelAsk(asked({ end_date: TODAY }), TODAY)).toBe(true)
    expect(isOpenCancelAsk(asked({ end_date: '2026-09-20' }), TODAY)).toBe(false)
    expect(cancelAskState(asked({ end_date: '2026-09-20' }), TODAY)).toBe('lapsed')
  })
})

describe('selfCancelMode — what cancelling your OWN approved leave means', () => {
  it('a manager or head coach must ask', () => {
    expect(selfCancelMode(MANAGER, leave(), TODAY, ['loc-1'])).toBe('ask')
    expect(selfCancelMode(HEAD_COACH, leave(), TODAY, ['loc-1'])).toBe('ask')
  })

  it('an owner must ask too', () => {
    expect(selfCancelMode(person('mgr', { 'loc-1': 'owner' }), leave(), TODAY, ['loc-1'])).toBe('ask')
  })

  it('a master cancels directly', () => {
    expect(selfCancelMode({ ...MASTER, id: 'mgr' }, leave(), TODAY, [])).toBe('direct')
  })

  it('a plain coach gets neither (the PUT refuses them, as before)', () => {
    expect(selfCancelMode(COACH, leave(), TODAY, ['loc-1'])).toBeNull()
  })

  it('manager-tier at ANOTHER studio the person belongs to counts, as it does in the PUT', () => {
    const mixed = person('mgr', { 'loc-1': 'staff', 'loc-2': 'manager' })
    expect(selfCancelMode(mixed, leave(), TODAY, ['loc-1', 'loc-2'])).toBe('ask')
  })

  it('someone else\'s leave, or leave that is not approved, is not this rule\'s business', () => {
    expect(selfCancelMode(OTHER_MANAGER, leave(), TODAY, ['loc-1'])).toBeNull()
    expect(selfCancelMode(MANAGER, leave({ status: 'pending' }), TODAY, ['loc-1'])).toBeNull()
  })

  it('leave whose last day has passed cannot be asked about; leave that has started can', () => {
    expect(selfCancelMode(MANAGER, leave({ start_date: '2026-09-01', end_date: '2026-09-20' }), TODAY, ['loc-1'])).toBe('ended')
    expect(selfCancelMode(MANAGER, leave({ start_date: '2026-09-18', end_date: '2026-09-25' }), TODAY, ['loc-1'])).toBe('ask')
  })
})

describe('canDecideLeaveCancel — an owner at a studio the request belongs to, or a master, never the requester', () => {
  it('owner yes; manager and head coach no', () => {
    expect(canDecideLeaveCancel(OWNER, asked(), ['loc-1'])).toBe(true)
    expect(canDecideLeaveCancel(OTHER_MANAGER, asked(), ['loc-1'])).toBe(false)
    expect(canDecideLeaveCancel(person('hc', { 'loc-1': 'head_coach' }), asked(), ['loc-1'])).toBe(false)
  })

  it('master yes, with no studio rows at all', () => {
    expect(canDecideLeaveCancel(MASTER, asked(), ['loc-1'])).toBe(true)
  })

  it('never the requester, owner or master or not', () => {
    expect(canDecideLeaveCancel(person('mgr', { 'loc-1': 'owner' }), asked(), ['loc-1'])).toBe(false)
    expect(canDecideLeaveCancel({ ...MASTER, id: 'mgr' }, asked(), ['loc-1'])).toBe(false)
  })

  it('an owner at the requester\'s OTHER studio decides; an owner somewhere unrelated does not', () => {
    const ownerAt2 = person('own-2', { 'loc-2': 'owner' })
    expect(canDecideLeaveCancel(ownerAt2, asked(), ['loc-1', 'loc-2'])).toBe(true)
    expect(canDecideLeaveCancel(ownerAt2, asked(), ['loc-1'])).toBe(false)
  })

  it('leaveActingLocationIds = filed-at plus the requester\'s studios, deduped', () => {
    expect(leaveActingLocationIds(leave(), ['loc-2', 'loc-1', null])).toEqual(['loc-1', 'loc-2'])
  })
})

describe('resolveLeaveCancelDeciderIds', () => {
  const link = (profile_id, location_id, role, profile = {}) => ({
    profile_id, location_id, role, profiles: { id: profile_id, role: 'staff', active: true, deleted_at: null, ...profile },
  })
  const db = ({ links = [], masters = [], linksError = null, mastersError = null } = {}) => fakeDb((q) => {
    if (q.table === 'profile_locations') return { data: linksError ? null : links, error: linksError }
    if (q.table === 'profiles') return { data: mastersError ? null : masters, error: mastersError }
    throw new Error(q.table)
  })

  it('owners at those studios, never the requester, never an inactive one; masters are not read while an owner exists', async () => {
    const d = db({ links: [
      link('own', 'loc-1', 'owner'), link('mgr', 'loc-1', 'owner'), link('gone', 'loc-1', 'owner', { active: false }),
      link('own', 'loc-2', 'owner'),
    ] })
    const res = await resolveLeaveCancelDeciderIds(d, ['loc-1', 'loc-2'], 'mgr')
    expect(res).toEqual({ ownerIds: ['own'], masterIds: [], error: null })
    const q = queriesOf(d, 'profile_locations')[0]
    expect(q.calls).toContainEqual(['in', 'location_id', ['loc-1', 'loc-2']])
    expect(q.calls).toContainEqual(['eq', 'role', 'owner'])
    expect(queriesOf(d, 'profiles')).toHaveLength(0)
  })

  it('no other owner: falls back to active masters, the requester excluded', async () => {
    const d = db({ links: [link('mgr', 'loc-1', 'owner')], masters: [{ id: 'boss' }, { id: 'mgr' }] })
    expect(await resolveLeaveCancelDeciderIds(d, ['loc-1'], 'mgr')).toEqual({ ownerIds: [], masterIds: ['boss'], error: null })
    const q = queriesOf(d, 'profiles')[0]
    expect(q.calls).toContainEqual(['eq', 'role', 'master'])
    expect(q.calls).toContainEqual(['eq', 'active', true])
  })

  it('an unreadable membership or master list is an error, never an empty answer', async () => {
    expect((await resolveLeaveCancelDeciderIds(db({ linksError: { message: 'boom' } }), ['loc-1'], 'mgr')).error).toEqual({ message: 'boom' })
    expect((await resolveLeaveCancelDeciderIds(db({ mastersError: { message: 'bang' } }), ['loc-1'], 'mgr')).error).toEqual({ message: 'bang' })
  })
})

describe('annotateCancelAsk — what the list tells the screen', () => {
  it('the requester of an open ask may withdraw it and nothing else', () => {
    expect(annotateCancelAsk(asked(), MANAGER, TODAY, ['loc-1'])).toEqual({
      cancel_request_state: 'open', can_request_cancel: false, cancel_needs_owner: false, can_withdraw_cancel: true, can_decide_cancel: false,
      cancel_retry_after: null, cancel_retry_after_label: null,
    })
  })

  it('an owner looking at it may decide it', () => {
    expect(annotateCancelAsk(asked(), OWNER, TODAY, ['loc-1'])).toMatchObject({ cancel_request_state: 'open', can_decide_cancel: true, can_withdraw_cancel: false })
  })

  it('another manager sees that it is open and can do nothing about it', () => {
    expect(annotateCancelAsk(asked(), OTHER_MANAGER, TODAY, ['loc-1'])).toEqual({
      cancel_request_state: 'open', can_request_cancel: false, cancel_needs_owner: false, can_withdraw_cancel: false, can_decide_cancel: false,
      cancel_retry_after: null, cancel_retry_after_label: null,
    })
  })

  it('a manager\'s own approved leave with no ask (or a declined one) offers the ask; a coach\'s never does', () => {
    expect(annotateCancelAsk(leave(), MANAGER, TODAY, ['loc-1']).can_request_cancel).toBe(true)
    const declined = asked({ cancel_decided_at: '2026-09-20T10:00:00Z', cancel_decision: 'rejected' })
    // A day after the decline (the clock is passed in, never read here).
    expect(annotateCancelAsk(declined, MANAGER, TODAY, ['loc-1'], Date.parse('2026-09-21T10:00:00Z'))).toMatchObject({
      cancel_request_state: 'rejected', can_request_cancel: true, cancel_needs_owner: true, cancel_retry_after: null, cancel_retry_after_label: null,
    })
    expect(annotateCancelAsk(leave(), COACH, TODAY, ['loc-1']).can_request_cancel).toBe(false)
  })

  // LEAVECANCEL.1 (review) — the PUT refuses a re-ask within 24h of a decline.
  // The list must agree, or the button shows and the dialog then 409s.
  it('within 24h of a decline the ask is NOT offered, and the row carries when it will be (Dublin wall clock)', () => {
    const declined = asked({ cancel_decided_at: '2026-09-20T10:00:00Z', cancel_decision: 'rejected' })
    expect(annotateCancelAsk(declined, MANAGER, TODAY, ['loc-1'], Date.parse('2026-09-20T13:30:00Z'))).toMatchObject({
      cancel_request_state: 'rejected', can_request_cancel: false, cancel_needs_owner: false,
      cancel_retry_after: '2026-09-21T10:00:00.000Z',
      // 10:00 UTC is 11:00 in Dublin in September (IST).
      cancel_retry_after_label: '11:00 on 21 Sep',
    })
  })

  it('says whether the button asks an owner (manager tier) or cancels outright (a master)', () => {
    expect(annotateCancelAsk(leave(), MANAGER, TODAY, ['loc-1'])).toMatchObject({ can_request_cancel: true, cancel_needs_owner: true })
    expect(annotateCancelAsk(leave(), { ...MASTER, id: 'mgr' }, TODAY, [])).toMatchObject({ can_request_cancel: true, cancel_needs_owner: false })
  })
})

describe('cancelAskEventKey', () => {
  it('is per ASK, so a second ask after a decline notifies again while a replay of the same ask does not', () => {
    const first = cancelAskEventKey('time_off_cancel_ask', asked())
    expect(first).toBe('time_off_cancel_ask:req-1:2026-09-20T09:00:00Z')
    expect(cancelAskEventKey('time_off_cancel_ask', asked())).toBe(first)
    expect(cancelAskEventKey('time_off_cancel_ask', asked({ cancel_requested_at: '2026-09-22T09:00:00Z' }))).not.toBe(first)
  })
})

describe('cancelAskNoticeKey — the ASK notice is at most one per leave per hour', () => {
  it('withdraw and re-ask inside the hour reuses the key (owners are not told twice); the next hour, or a replay, behaves as expected', () => {
    const first = cancelAskNoticeKey(asked({ cancel_requested_at: '2026-09-20T09:05:00.000Z' }))
    expect(first).toBe('time_off_cancel_ask:req-1:2026-09-20T09')
    expect(cancelAskNoticeKey(asked({ cancel_requested_at: '2026-09-20T09:55:00.000Z' }))).toBe(first)
    expect(cancelAskNoticeKey(asked({ cancel_requested_at: '2026-09-20T10:05:00.000Z' }))).not.toBe(first)
  })
})

describe('reAskBlockedUntil — one re-ask per 24h after a DECLINE (each ask notifies every owner)', () => {
  const declined = asked({ cancel_decided_at: '2026-09-20T10:00:00.000Z', cancel_decision: 'rejected' })
  it('blocked inside 24h, with the instant it lifts; free after', () => {
    expect(reAskBlockedUntil(declined, Date.parse('2026-09-21T09:59:00Z'))).toBe('2026-09-21T10:00:00.000Z')
    expect(reAskBlockedUntil(declined, Date.parse('2026-09-21T10:00:00Z'))).toBeNull()
  })
  it('never asked, withdrawn, or an approved cancellation: nothing to wait for', () => {
    expect(reAskBlockedUntil(leave(), Date.parse('2026-09-20T10:01:00Z'))).toBeNull()
    expect(reAskBlockedUntil(asked({ cancel_decided_at: '2026-09-20T10:00:00.000Z', cancel_decision: 'approved' }), Date.parse('2026-09-20T10:01:00Z'))).toBeNull()
  })
})

describe('dublinRetryLabel — "HH:MM on D Mon", Dublin wall clock, whatever the process timezone', () => {
  it('reads Irish summer time and winter time', () => {
    expect(dublinRetryLabel('2026-09-22T13:30:00.000Z')).toBe('14:30 on 22 Sep')
    expect(dublinRetryLabel('2026-12-01T14:30:00.000Z')).toBe('14:30 on 1 Dec')
    // Late evening UTC is already the next day in Dublin in summer.
    expect(dublinRetryLabel('2026-06-30T23:30:00.000Z')).toBe('00:30 on 1 Jul')
  })
  it('null for anything unreadable', () => {
    expect(dublinRetryLabel(null)).toBeNull()
    expect(dublinRetryLabel('not a date')).toBeNull()
  })
})

describe('CLEARED_CANCEL_ASK', () => {
  it('is exactly the seven mig 624 columns, all null', () => {
    expect(CLEARED_CANCEL_ASK).toEqual({
      cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null,
      cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
    })
    expect(Object.isFrozen(CLEARED_CANCEL_ASK)).toBe(true)
  })
})

describe('copy shared by the Time Off page and the dashboard card', () => {
  it('has a line for every outcome and no em dash', () => {
    for (const k of ['requested', 'approved', 'rejected', 'withdrawn']) {
      expect(typeof LEAVE_CANCEL_NOTICES[k]).toBe('string')
      expect(LEAVE_CANCEL_NOTICES[k]).not.toContain('—')
    }
  })
  it('a cancelled row whose cancellation an owner approved says who asked and who approved', () => {
    const row = { status: 'cancelled', cancel_decision: 'approved', profiles: { full_name: 'Mia Manager' }, cancel_decider: { full_name: 'Olive Owner' } }
    expect(cancelledAtRequestText(row, { own: false })).toBe("Cancelled at Mia Manager's request, approved by Olive Owner.")
    expect(cancelledAtRequestText(row, { own: true })).toBe('Cancelled at your request, approved by Olive Owner.')
    expect(cancelledAtRequestText({ ...row, cancel_decider: null }, { own: true })).toBe('Cancelled at your request, approved by an owner.')
    expect(cancelledAtRequestText({ status: 'cancelled', cancel_decision: null }, { own: true })).toBeNull()
    expect(cancelledAtRequestText({ status: 'approved', cancel_decision: 'rejected' }, { own: true })).toBeNull()
  })
})

// LEAVECANCEL.1 (review) — code that reaches prod before mig 624 does (a
// Vercel preview of this branch, or an ordering slip) must turn the NEW feature
// off, not break the leave list. These are the exact shapes PostgREST and
// Postgres answer when the cancel_* columns / FK are not there.
describe('isMissingCancelSchemaError', () => {
  it('PGRST200: the cancel_decider embed hint names a relationship that does not exist yet', () => {
    expect(isMissingCancelSchemaError({
      code: 'PGRST200',
      message: "Could not find a relationship between 'time_off_requests' and 'profiles' in the schema cache",
      details: "Searched for a foreign key relationship between 'time_off_requests' and 'profiles' using the hint 'cancel_decided_by' in the schema 'public', but no matches were found.",
    })).toBe(true)
  })
  it('42703: a filter, order or select on a cancel_* column Postgres does not have', () => {
    expect(isMissingCancelSchemaError({ code: '42703', message: 'column time_off_requests.cancel_requested_at does not exist' })).toBe(true)
  })
  it('PGRST204: a write naming a cancel_* column PostgREST has never heard of', () => {
    expect(isMissingCancelSchemaError({ code: 'PGRST204', message: "Could not find the 'cancel_decided_at' column of 'time_off_requests' in the schema cache" })).toBe(true)
  })
  it('the same codes about ANYTHING ELSE are not this, and neither is any other error', () => {
    expect(isMissingCancelSchemaError({ code: 'PGRST200', message: "Could not find a relationship between 'time_off_requests' and 'profiles'", details: "using the hint 'reviewed_by'" })).toBe(false)
    expect(isMissingCancelSchemaError({ code: '42703', message: 'column time_off_requests.reason does not exist' })).toBe(false)
    expect(isMissingCancelSchemaError({ code: '57014', message: 'canceling statement due to statement timeout, cancel_requested_at' })).toBe(false)
    expect(isMissingCancelSchemaError(null)).toBe(false)
    expect(isMissingCancelSchemaError({ message: 'cancel_requested_at' })).toBe(false)
  })
  it('CANCEL_ASK_OFF is the annotation for a row when the feature is not there: nothing offered, nothing waiting', () => {
    expect(CANCEL_ASK_OFF).toEqual({
      cancel_request_state: null, can_request_cancel: false, cancel_needs_owner: false,
      can_withdraw_cancel: false, can_decide_cancel: false, cancel_retry_after: null, cancel_retry_after_label: null,
    })
    expect(Object.isFrozen(CANCEL_ASK_OFF)).toBe(true)
  })
})

// LEAVEGUARD.1 — a colleague taking a manager's APPROVED leave out of force
// needs the cancellation decider (an owner who is not the requester, or a
// master); a master's needs another master.
describe('requesterLeaveTier — ONE definition for the PUT and the list', () => {
  const tier = (who, locs = ['loc-1']) => requesterLeaveTier(who, leave(), locs)

  it('manager, head coach or owner at the filed-at studio: manager; staff: staff', () => {
    for (const role of ['manager', 'head_coach', 'owner']) expect(tier({ memberships: [{ location_id: 'loc-1', role }] })).toBe('manager')
    expect(tier({ memberships: [{ location_id: 'loc-1', role: 'staff' }] })).toBe('staff')
    expect(tier({}, [])).toBe('staff')
  })

  it('a manager role at their OTHER studio counts (leave covers the person, LEAVE.2); one at an unrelated studio does not', () => {
    expect(tier({ memberships: [{ location_id: 'loc-1', role: 'staff' }, { location_id: 'loc-2', role: 'manager' }] }, ['loc-1', 'loc-2'])).toBe('manager')
    expect(tier({ memberships: [{ location_id: 'loc-9', role: 'owner' }] })).toBe('staff')
  })

  it('profiles.role master is master, with no studio rows at all', () => {
    expect(tier({ profileRole: 'master', memberships: [] }, [])).toBe('master')
    expect(tier({ profileRole: 'master', memberships: null, orgAdminLocationIds: null })).toBe('master')
  })

  it('an org admin of an organisation owning one of the studios is manager-tier (their synthetic owner role, SAAS-4); of another organisation, not', () => {
    expect(tier({ memberships: [{ location_id: 'loc-1', role: 'staff' }], orgAdminLocationIds: ['loc-1', 'loc-2'] })).toBe('manager')
    expect(tier({ memberships: [], orgAdminLocationIds: ['loc-x'] })).toBe('staff')
  })

  it('unreadable memberships or org grants, and nothing found: null (unknown), never staff', () => {
    expect(tier({ memberships: null })).toBeNull()
    expect(tier({ memberships: [], orgAdminLocationIds: null })).toBeNull()
    // Something positive found still answers.
    expect(tier({ memberships: [{ location_id: 'loc-1', role: 'owner' }], orgAdminLocationIds: null })).toBe('manager')
  })
})

describe('approvedLeaveGuardAllows — who may move APPROVED leave out of force', () => {
  const mgrLeave = leave({ profile_id: 'mgr' })
  const ANOTHER_OWNER = person('own-2', { 'loc-1': 'owner' })
  const ORG_ADMIN_CALLER = person('oa', { 'loc-1': 'owner' }) // getCurrentUser's synthetic owner

  it('a manager-tier requester\'s approved leave: only an owner (not them) or a master', () => {
    for (const to of ['cancelled', 'rejected', 'pending']) {
      expect(approvedLeaveGuardAllows(OTHER_MANAGER, mgrLeave, to, ['loc-1'], 'manager')).toBe(false)
      expect(approvedLeaveGuardAllows(person('hc', { 'loc-1': 'head_coach' }), mgrLeave, to, ['loc-1'], 'manager')).toBe(false)
      expect(approvedLeaveGuardAllows(OWNER, mgrLeave, to, ['loc-1'], 'manager')).toBe(true)
      expect(approvedLeaveGuardAllows(ANOTHER_OWNER, mgrLeave, to, ['loc-1'], 'manager')).toBe(true)
      expect(approvedLeaveGuardAllows(ORG_ADMIN_CALLER, mgrLeave, to, ['loc-1'], 'manager')).toBe(true)
      expect(approvedLeaveGuardAllows(MASTER, mgrLeave, to, ['loc-1'], 'manager')).toBe(true)
    }
  })

  it('a MASTER requester\'s approved leave: only another master; an owner is not above a master', () => {
    expect(approvedLeaveGuardAllows(OWNER, mgrLeave, 'cancelled', ['loc-1'], 'master')).toBe(false)
    expect(approvedLeaveGuardAllows(OTHER_MANAGER, mgrLeave, 'rejected', ['loc-1'], 'master')).toBe(false)
    expect(approvedLeaveGuardAllows(MASTER, mgrLeave, 'pending', ['loc-1'], 'master')).toBe(true)
  })

  it('staff leave, pending leave and a re-stamp to approved are not this rule\'s business', () => {
    expect(approvedLeaveGuardAllows(OTHER_MANAGER, mgrLeave, 'cancelled', ['loc-1'], 'staff')).toBe(true)
    expect(approvedLeaveGuardAllows(OTHER_MANAGER, leave({ status: 'pending' }), 'rejected', ['loc-1'], 'manager')).toBe(true)
    expect(approvedLeaveGuardAllows(OTHER_MANAGER, mgrLeave, 'approved', ['loc-1'], 'master')).toBe(true)
  })

  it('the requester\'s own leave is LEAVECANCEL.1\'s path, not this one', () => {
    expect(approvedLeaveGuardAllows(MANAGER, mgrLeave, 'cancelled', ['loc-1'], 'manager')).toBe(true)
  })

  it('an unreadable tier (null) is judged as manager: authority only narrows', () => {
    expect(approvedLeaveGuardAllows(OTHER_MANAGER, mgrLeave, 'cancelled', ['loc-1'], null)).toBe(false)
    expect(approvedLeaveGuardAllows(OWNER, mgrLeave, 'cancelled', ['loc-1'], null)).toBe(true)
  })

  it('an owner only at a studio the request does not belong to is refused', () => {
    expect(approvedLeaveGuardAllows(person('own-9', { 'loc-9': 'owner' }), mgrLeave, 'cancelled', ['loc-1'], 'manager')).toBe(false)
  })

  it('the refusal says what to do instead, per tier, with no em-dash', () => {
    expect(approvedLeaveRefusal('manager')).toBe("Only an owner can change a manager's approved leave. Ask the person whose leave it is to request the cancellation, or ask an owner.")
    expect(approvedLeaveRefusal(null)).toBe(approvedLeaveRefusal('manager'))
    expect(approvedLeaveRefusal('master')).toBe("Only another master can change a master's approved leave.")
    for (const t of ['manager', 'master']) expect(approvedLeaveRefusal(t)).not.toMatch(/—/)
  })
})

describe('annotateApprovedLeaveGuard — the list\'s per-row flag', () => {
  it('locked for a manager looking at a fellow manager\'s approved leave; not for an owner, and not on staff leave', () => {
    expect(annotateApprovedLeaveGuard(leave(), OTHER_MANAGER, ['loc-1'], 'manager')).toEqual({ approved_locked_to_owner: true })
    expect(annotateApprovedLeaveGuard(leave(), OWNER, ['loc-1'], 'manager')).toEqual({ approved_locked_to_owner: false })
    expect(annotateApprovedLeaveGuard(leave(), OWNER, ['loc-1'], 'master')).toEqual({ approved_locked_to_owner: true })
    expect(annotateApprovedLeaveGuard(leave(), OTHER_MANAGER, ['loc-1'], 'staff')).toEqual({ approved_locked_to_owner: false })
    expect(annotateApprovedLeaveGuard(leave({ status: 'pending' }), OTHER_MANAGER, ['loc-1'], 'manager')).toEqual({ approved_locked_to_owner: false })
    expect(annotateApprovedLeaveGuard(leave(), MANAGER, ['loc-1'], 'manager')).toEqual({ approved_locked_to_owner: false })
  })
})
