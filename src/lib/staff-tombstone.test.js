// src/lib/staff-tombstone.test.js
import { describe, it, expect, vi } from 'vitest'
import {
  isTombstone, excludeTombstones, tombstoneEmail, authDisposition, tombstoneErrorStatus,
  coverNoticesByLocation, swapCounterparties, describeTombstoneImpact,
  roleAtDeletion, TOMBSTONE_FLOOR_ROLE,
} from './staff-tombstone.js'

const ID = '10000000-0000-0000-0000-000000000001'

describe('isTombstone / excludeTombstones', () => {
  it('a profile is a tombstone iff deleted_at is set', () => {
    expect(isTombstone({ id: ID, deleted_at: '2026-09-19T10:00:00Z' })).toBe(true)
    expect(isTombstone({ id: ID, deleted_at: null })).toBe(false)
    expect(isTombstone({ id: ID, active: false })).toBe(false) // deactivated is NOT deleted
    expect(isTombstone(null)).toBe(false)
  })
  it('excludeTombstones adds exactly one filter and hands the builder back', () => {
    const q = { is: vi.fn(function is() { return this }) }
    expect(excludeTombstones(q)).toBe(q)
    expect(q.is).toHaveBeenCalledTimes(1)
    expect(q.is).toHaveBeenCalledWith('deleted_at', null)
  })
})

describe('tombstoneEmail', () => {
  it('is unique per profile, lower-case, and on a domain that can never receive mail', () => {
    expect(tombstoneEmail(ID)).toBe(`deleted+${ID}@deleted.invalid`)
    expect(tombstoneEmail('ABCDEF00-0000-0000-0000-000000000001')).toBe('deleted+abcdef00-0000-0000-0000-000000000001@deleted.invalid')
  })
})

describe('authDisposition', () => {
  it('bans a staff-only login', () => {
    expect(authDisposition({ memberContact: null, hostUser: null, readFailed: false })).toBe('ban')
  })
  it('keeps the login when the same person is a member or a host', () => {
    expect(authDisposition({ memberContact: { id: 'c1' }, hostUser: null, readFailed: false })).toBe('kept_member_login')
    expect(authDisposition({ memberContact: null, hostUser: { host_id: 'h1' }, readFailed: false })).toBe('kept_host_login')
  })
  it('an unreadable answer KEEPS the login — locking a paying member out is the worse mistake', () => {
    expect(authDisposition({ memberContact: null, hostUser: null, readFailed: true })).toBe('kept_unverified')
  })
})

describe('tombstoneErrorStatus', () => {
  it('maps the function\'s message prefixes to HTTP', () => {
    expect(tombstoneErrorStatus('staff_not_found: no profile x')).toEqual({ status: 404, error: 'Profile not found' })
    expect(tombstoneErrorStatus('staff_already_deleted: x').status).toBe(409)
    expect(tombstoneErrorStatus('staff_still_active: x').status).toBe(400)
    expect(tombstoneErrorStatus('staff_self_delete: x').status).toBe(400)
    expect(tombstoneErrorStatus('deadlock detected')).toEqual({ status: 500, error: 'Permanent delete failed: deadlock detected' })
  })
})

describe('coverNoticesByLocation', () => {
  it('one notice per studio, PUBLISHED shifts only, with the earliest date', () => {
    expect(coverNoticesByLocation([
      { location_id: 'loc-1', block_date: '2026-10-07', roster_status: 'published' },
      { location_id: 'loc-1', block_date: '2026-10-05', roster_status: 'published' },
      { location_id: 'loc-1', block_date: '2026-10-06', roster_status: 'draft' },
      { location_id: 'loc-2', block_date: '2026-10-09', roster_status: 'published' },
    ])).toEqual([
      { locationId: 'loc-1', count: 2, firstDate: '2026-10-05' },
      { locationId: 'loc-2', count: 1, firstDate: '2026-10-09' },
    ])
    expect(coverNoticesByLocation(null)).toEqual([])
  })
})

describe('swapCounterparties', () => {
  it('the OTHER person on each cancelled swap; open-pool swaps have nobody to tell', () => {
    expect(swapCounterparties([
      { id: 's1', requester_id: ID, target_id: 'peer-1' },
      { id: 's2', requester_id: 'peer-2', target_id: ID },
      { id: 's3', requester_id: ID, target_id: null },
    ], ID)).toEqual([{ swapId: 's1', notifyId: 'peer-1' }, { swapId: 's2', notifyId: 'peer-2' }])
  })
})

describe('describeTombstoneImpact', () => {
  it('says exactly what goes and what stays', () => {
    expect(describeTombstoneImpact({
      removed_shifts: [{}, {}, {}], cancelled_swaps: [{}], cancelled_time_off: [],
      kept: { past_shifts: 212, time_off_requests: 9, contractor_invoices: 4 },
    })).toEqual({
      removes: [
        'Removed from 3 upcoming shifts. These will need cover.',
        '1 open swap request cancelled.',
      ],
      keeps: 'Kept, under their name: 212 past shifts, 9 leave requests, 4 invoices, their allowance and pay records, and every report.',
    })
  })
  it('nothing upcoming reads as nothing upcoming', () => {
    const d = describeTombstoneImpact({ removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [{}, {}], kept: {} })
    expect(d.removes).toEqual(['They are on no upcoming shifts.', '2 pending leave requests cancelled.'])
    expect(d.keeps).toBe('Kept, under their name: their allowance and pay records, and every report.')
  })
})

describe('roleAtDeletion', () => {
  it('a tombstone is demoted to the floor role; its ROLE HISTORY is deleted_role', () => {
    expect(TOMBSTONE_FLOOR_ROLE).toBe('staff')
    expect(roleAtDeletion({ role: 'staff', deleted_role: 'master', deleted_at: '2026-09-19T10:00:00Z' })).toBe('master')
    expect(roleAtDeletion({ role: 'manager', deleted_role: null })).toBe('manager')
    expect(roleAtDeletion({ role: 'owner' })).toBe('owner')
    expect(roleAtDeletion(null)).toBeNull()
  })
})

describe('describeTombstoneImpact — today\'s started shifts and the demotion', () => {
  it('lists today\'s already-started shifts as KEPT, separately from what is removed', () => {
    const d = describeTombstoneImpact({
      removed_shifts: [{}], kept_today_shifts: [{}, {}], cancelled_swaps: [], cancelled_time_off: [], kept: {},
      role: { from: 'staff', to: 'staff' },
    })
    expect(d.removes).toEqual(['Removed from 1 upcoming shift. These will need cover.'])
    expect(d.keptToday).toBe("Today's shifts already started: kept (2 shifts).")
    expect(d.demotion).toBeUndefined()
  })
  it('a shift they have already ARRIVED for is kept too, and says why', () => {
    const d = describeTombstoneImpact({
      removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [], kept: {},
      kept_today_shifts: [{ reason: 'started' }, { reason: 'arrived' }],
    })
    expect(d.keptToday).toBe("Today's shifts already started: kept (1 shift). Already arrived for 1 upcoming shift: kept.")
    const onlyArrived = describeTombstoneImpact({ removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [], kept: {}, kept_today_shifts: [{ reason: 'arrived' }, { reason: 'arrived' }] })
    expect(onlyArrived.keptToday).toBe('Already arrived for 2 upcoming shifts: kept.')
  })
  it('says in plain words that an elevated role is removed and remembered', () => {
    const d = describeTombstoneImpact({
      removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [], kept: {}, role: { from: 'master', to: 'staff' },
    })
    expect(d.demotion).toBe('Their master role is removed (the account is reduced to basic staff so it keeps no admin rights). The record still shows their role was master.')
    expect(d.keptToday).toBeUndefined()
  })
})
