// LEAVECANCEL.1 — the rules a cancellation of APPROVED leave is judged by.

import { describe, it, expect } from 'vitest'
import {
  isOpenCancelAsk, cancelAskState, selfCancelMode, canDecideLeaveCancel, leaveActingLocationIds,
  resolveLeaveCancelDeciderIds, annotateCancelAsk, cancelAskEventKey,
} from './time-off-cancel.js'
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
    })
  })

  it('an owner looking at it may decide it', () => {
    expect(annotateCancelAsk(asked(), OWNER, TODAY, ['loc-1'])).toMatchObject({ cancel_request_state: 'open', can_decide_cancel: true, can_withdraw_cancel: false })
  })

  it('another manager sees that it is open and can do nothing about it', () => {
    expect(annotateCancelAsk(asked(), OTHER_MANAGER, TODAY, ['loc-1'])).toEqual({
      cancel_request_state: 'open', can_request_cancel: false, cancel_needs_owner: false, can_withdraw_cancel: false, can_decide_cancel: false,
    })
  })

  it('a manager\'s own approved leave with no ask (or a declined one) offers the ask; a coach\'s never does', () => {
    expect(annotateCancelAsk(leave(), MANAGER, TODAY, ['loc-1']).can_request_cancel).toBe(true)
    const declined = asked({ cancel_decided_at: '2026-09-20T10:00:00Z', cancel_decision: 'rejected' })
    expect(annotateCancelAsk(declined, MANAGER, TODAY, ['loc-1'])).toMatchObject({ cancel_request_state: 'rejected', can_request_cancel: true })
    expect(annotateCancelAsk(leave(), COACH, TODAY, ['loc-1']).can_request_cancel).toBe(false)
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
