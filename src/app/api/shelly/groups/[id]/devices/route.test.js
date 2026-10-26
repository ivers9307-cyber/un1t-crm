// SHELLYGROUPS.5 — PUT /api/shelly/groups/[id]/devices: the group's whole
// membership.
//
//  1. EVERY id must be a device at the caller's location. One foreign or
//     unknown id answers 404 and NOTHING changes (no partial membership).
//  2. A device JOINING has its own schedule cleared (mode none, no windows,
//     empty rule) so leaving later can never revive a stale schedule; its
//     `enabled` is kept.
//  3. A device LEAVING gets group_id null and nothing else, and nothing is
//     sent to any relay.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/shelly/client', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, createShellyClient: vi.fn() }
})

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, GRP_A, GRP_B, BAD_ID, OWNER_A, STAFF_A,
  deviceRow, groupRow, makeDb, updatesTo, jsonReq, ctxFor,
} from '../../../shelly-routes.test-helpers.js'

const URL = 'http://localhost/api/shelly/groups/x/devices'
const DEV_A2 = 'd0000000-0000-4000-8000-0000000000a2'
const DEV_A3 = 'd0000000-0000-4000-8000-0000000000a3'
const GRP_A2 = '90000000-0000-4000-8000-0000000000a2'
const putReq = (body) => jsonReq(body, URL, 'PUT')

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
const fixed = [{ days: [1], on: '07:00', off: '09:00' }]
const world = () => ({
  rows: {
    shelly_groups: [groupRow(), groupRow({ id: GRP_A2, name: 'Fans' }), groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' })],
    shelly_devices: [
      // Joining, with a schedule of its own and enabled.
      deviceRow({ id: DEV_A, group_id: null, enabled: true, schedule_mode: 'fixed', fixed_windows: fixed, class_rule: { lead_min: 5 } }),
      // Already a member, staying.
      deviceRow({ id: DEV_A2, device_id: 'aabbcc000002', group_id: GRP_A, enabled: false, schedule_mode: 'none', fixed_windows: [] }),
      // A member, leaving.
      deviceRow({ id: DEV_A3, device_id: 'aabbcc000003', group_id: GRP_A, enabled: true, schedule_mode: 'none', fixed_windows: [] }),
      deviceRow({ id: DEV_B, location_id: LOC_B, device_id: 'ffeedd998877', group_id: GRP_B }),
    ],
  },
})
const dev = (id) => db.rowsIn('shelly_devices').find((d) => d.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(world())
})

describe('PUT /api/shelly/groups/[id]/devices', () => {
  it('sets the membership: joiners get the group and lose their own schedule, leavers are released', async () => {
    const res = await PUT(putReq({ device_ids: [DEV_A, DEV_A2] }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.device_ids.sort()).toEqual([DEV_A, DEV_A2].sort())
    expect(body).toMatchObject({ joined: [DEV_A], left: [DEV_A3] })

    expect(dev(DEV_A)).toMatchObject({ group_id: GRP_A, schedule_mode: 'none', fixed_windows: [], class_rule: {}, enabled: true })
    expect(dev(DEV_A2)).toMatchObject({ group_id: GRP_A })
    // Leaving touches group_id only.
    expect(dev(DEV_A3)).toMatchObject({ group_id: null, enabled: true, schedule_mode: 'none' })
    for (const u of updatesTo(db, 'shelly_devices')) expect(u.filters.location_id).toBe(LOC_A)
    const leave = updatesTo(db, 'shelly_devices').find((u) => u.payload.group_id === null)
    expect(Object.keys(leave.payload).sort()).toEqual(['group_id', 'updated_at'])
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('a device moving from another group at the studio joins this one', async () => {
    db.rowsIn('shelly_devices').find((d) => d.id === DEV_A).group_id = GRP_A2
    await PUT(putReq({ device_ids: [DEV_A, DEV_A2, DEV_A3] }), ctxFor(GRP_A))
    expect(dev(DEV_A).group_id).toBe(GRP_A)
  })

  it('an empty list empties the group', async () => {
    const body = await (await PUT(putReq({ device_ids: [] }), ctxFor(GRP_A))).json()
    expect(body.device_ids).toEqual([])
    expect(dev(DEV_A2).group_id).toBeNull()
    expect(dev(DEV_A3).group_id).toBeNull()
  })

  it('a foreign device id is a 404 and nothing changes', async () => {
    const before = JSON.stringify(db.rowsIn('shelly_devices'))
    const res = await PUT(putReq({ device_ids: [DEV_A, DEV_B] }), ctxFor(GRP_A))
    expect(res.status).toBe(404)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
    expect(JSON.stringify(db.rowsIn('shelly_devices'))).toBe(before)
  })

  it('an unknown device id is the same 404', async () => {
    const res = await PUT(putReq({ device_ids: ['d0000000-0000-4000-8000-0000000000ff'] }), ctxFor(GRP_A))
    expect(res.status).toBe(404)
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
  })

  it('a foreign group id and a malformed one are the same 404', async () => {
    const foreign = await PUT(putReq({ device_ids: [] }), ctxFor(GRP_B))
    const malformed = await PUT(putReq({ device_ids: [] }), ctxFor(BAD_ID))
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await malformed.json())
    expect(dev(DEV_B).group_id).toBe(GRP_B)
  })

  it('a failed write is a 500, checked rather than assumed', async () => {
    db.conf.updateError.shelly_devices = { message: 'pg down' }
    expect((await PUT(putReq({ device_ids: [DEV_A] }), ctxFor(GRP_A))).status).toBe(500)
  })

  it('400s duplicates and a non-uuid', async () => {
    expect((await PUT(putReq({ device_ids: [DEV_A, DEV_A] }), ctxFor(GRP_A))).status).toBe(400)
    expect((await PUT(putReq({ device_ids: ['x'] }), ctxFor(GRP_A))).status).toBe(400)
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await PUT(putReq({ device_ids: [] }), ctxFor(GRP_A))).status).toBe(403)
  })
})
