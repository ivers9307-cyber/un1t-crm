// SHELLYGROUPS.5 — PATCH/DELETE one group.
//
// The tenant filter is on the WRITE, a foreign id and a malformed one answer
// the same 404, a rename refuses a case-insensitive clash with ANOTHER group
// (renaming "Fans" to "fans" is fine), and deleting switches nothing: the FK
// releases the members (ON DELETE SET NULL).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

import { PATCH, DELETE, GROUP_DISABLE_NOTICE, GROUP_DELETED_MESSAGE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import {
  LOC_A, LOC_B, GRP_A, GRP_B, BAD_ID, OWNER_A, STAFF_A, DEV_A, DEV_B,
  groupRow, deviceRow, makeDb, updatesTo, deletesFrom, jsonReq, req, ctxFor,
} from '../../shelly-routes.test-helpers.js'

const URL = 'http://localhost/api/shelly/groups/x'
const GRP_A2 = '90000000-0000-4000-8000-0000000000a2'
const patchReq = (body) => jsonReq(body, URL, 'PATCH')

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
const world = (over = {}, extra = []) => ({
  rows: {
    shelly_groups: [
      groupRow(over),
      groupRow({ id: GRP_A2, name: 'Fans' }),
      groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' }),
      ...extra,
    ],
  },
})
const rowOf = (id) => db.rowsIn('shelly_groups').find((g) => g.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(world())
})

describe('PATCH /api/shelly/groups/[id]', () => {
  it('renames, pinning the location on the write, and never returns last_applied', async () => {
    const res = await PATCH(patchReq({ name: 'Studio lights', icon: 'tv', sort_order: 2 }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.group).toMatchObject({ id: GRP_A, name: 'Studio lights', icon: 'tv', sort_order: 2 })
    expect(body.group).not.toHaveProperty('last_applied')
    expect(updatesTo(db, 'shelly_groups')[0].filters).toEqual({ id: GRP_A, location_id: LOC_A })
  })

  it('refuses a case-insensitive clash with another group at the studio (409 name_taken)', async () => {
    const res = await PATCH(patchReq({ name: 'FANS' }), ctxFor(GRP_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('a re-case of its own name is not a clash', async () => {
    expect((await PATCH(patchReq({ name: 'GYM FLOOR' }), ctxFor(GRP_A))).status).toBe(200)
  })

  it('another studio’s group of the same name is not a clash', async () => {
    expect((await PATCH(patchReq({ name: 'theirs' }), ctxFor(GRP_A))).status).toBe(200)
  })

  it('maps a raw 23505 to 409 name_taken', async () => {
    db.conf.updateError.shelly_groups = { code: '23505', message: 'dup' }
    const res = await PATCH(patchReq({ name: 'New' }), ctxFor(GRP_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
  })

  it('saves a schedule with class_rule defaults filled in', async () => {
    const res = await PATCH(patchReq({ enabled: true, schedule_mode: 'class', class_rule: { days: [1, 2, 3, 4, 5] } }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(rowOf(GRP_A).class_rule).toEqual({ lead_min: 15, lag_min: 10, merge_gap_min: 30, days: [1, 2, 3, 4, 5] })
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('merges a PARTIAL class_rule onto the stored one', async () => {
    useDb(world({ schedule_mode: 'class', enabled: true, class_rule: { lead_min: 15, lag_min: 5, merge_gap_min: 45, days: [1, 3] } }))
    const res = await PATCH(patchReq({ class_rule: { lead_min: 20 } }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(rowOf(GRP_A).class_rule).toEqual({ lead_min: 20, lag_min: 5, merge_gap_min: 45, days: [1, 3] })
    expect((await res.json()).group.class_rule).toEqual({ lead_min: 20, lag_min: 5, merge_gap_min: 45, days: [1, 3] })
  })

  it('drops keys the engine does not read from the stored rule when merging', async () => {
    useDb(world({ class_rule: { lead_min: 5, junk: 'x' } }))
    await PATCH(patchReq({ class_rule: { lag_min: 0 } }), ctxFor(GRP_A))
    expect(rowOf(GRP_A).class_rule).toEqual({ lead_min: 5, lag_min: 0, merge_gap_min: 30, days: [1, 2, 3, 4, 5, 6, 7] })
  })

  it('400s when the MERGED rule is invalid, writing nothing', async () => {
    useDb(world({ class_rule: { lead_min: 999 } }))
    const res = await PATCH(patchReq({ class_rule: { lag_min: 5 } }), ctxFor(GRP_A))
    expect(res.status).toBe(400)
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('switching a running schedule off says the lights stay as they are', async () => {
    useDb(world({ enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '07:00', off: '09:00' }] }))
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(GRP_A))).json()
    expect(body.notice).toBe(GROUP_DISABLE_NOTICE)
    const quiet = await (await PATCH(patchReq({ name: 'x' }), ctxFor(GRP_A))).json()
    expect(quiet).not.toHaveProperty('notice')
  })

  it('404s a foreign id and a malformed one identically, the foreign row untouched', async () => {
    const before = JSON.stringify(rowOf(GRP_B))
    const foreign = await PATCH(patchReq({ name: 'Mine now' }), ctxFor(GRP_B))
    const malformed = await PATCH(patchReq({ name: 'Mine now' }), ctxFor(BAD_ID))
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await malformed.json())
    expect(JSON.stringify(rowOf(GRP_B))).toBe(before)
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('400s an empty patch and a location_id', async () => {
    expect((await PATCH(patchReq({}), ctxFor(GRP_A))).status).toBe(400)
    expect((await PATCH(patchReq({ location_id: LOC_B }), ctxFor(GRP_A))).status).toBe(400)
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await PATCH(patchReq({ name: 'x' }), ctxFor(GRP_A))).status).toBe(403)
  })
})

describe('DELETE /api/shelly/groups/[id]', () => {
  it('deletes the caller’s group, pinning the location, and switches nothing', async () => {
    const res = await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(rowOf(GRP_A)).toBeUndefined()
    expect(deletesFrom(db, 'shelly_groups')[0].filters).toEqual({ id: GRP_A, location_id: LOC_A })
    // Members are released by the FK, not by the route, and nothing is sent.
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('404s a foreign id, the row surviving', async () => {
    const res = await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_B))
    expect(res.status).toBe(404)
    expect(rowOf(GRP_B)).toBeDefined()
    expect(deletesFrom(db, 'shelly_groups')).toEqual([])
  })

  it('500s a failed delete', async () => {
    db.conf.deleteError.shelly_groups = { message: 'pg down' }
    expect((await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))).status).toBe(500)
  })
})

// SHELLYTIMERS.6 — switching the schedule off or removing the group: "stay as
// they are" holds only until a member's pending safety timer.
describe('/api/shelly/groups/[id] — notices name a pending safety timer', () => {
  const NOW = Date.parse('2026-08-23T12:00:00.000Z')
  const SENTENCE = ' A light the schedule switched on still switches itself off by 21:30 (safety timer).'
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
  afterEach(() => vi.useRealTimers())
  const withMembers = (over, members) => {
    const w = world(over)
    w.rows.shelly_devices = members
    return w
  }
  const armed = deviceRow({ id: DEV_A, group_id: GRP_A, last_applied: { key: 'w:1', action: 'on', cap_at: '2026-08-23T20:30:00.000Z' } })
  const managedOver = { enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '07:00', off: '09:00' }] }

  it('PATCH disable: the notice gains the time (latest member cap, studio zone)', async () => {
    const earlier = deviceRow({ id: 'd0000000-0000-4000-8000-0000000000a9', device_id: 'aabbcc000009', group_id: GRP_A, last_state: { timer_until: '2026-08-23T14:00:00.000Z' } })
    // Another studio's member with a later cap must not leak into the answer.
    const foreign = deviceRow({ id: DEV_B, location_id: LOC_B, device_id: 'ffeedd998877', group_id: GRP_A, last_applied: { action: 'on', cap_at: '2026-08-23T23:00:00.000Z' } })
    useDb(withMembers(managedOver, [armed, earlier, foreign]))
    const body = await (await PATCH(patchReq({ enabled: false }), ctxFor(GRP_A))).json()
    expect(body.notice).toBe(`${GROUP_DISABLE_NOTICE}.${SENTENCE}`)
  })

  it('PATCH disable with no pending timer, or an unreadable member list, keeps the plain notice', async () => {
    useDb(withMembers(managedOver, [deviceRow({ id: DEV_A, group_id: GRP_A, last_applied: { action: 'off' } })]))
    expect((await (await PATCH(patchReq({ enabled: false }), ctxFor(GRP_A))).json()).notice).toBe(GROUP_DISABLE_NOTICE)
    useDb({ ...withMembers(managedOver, [armed]), selectError: { shelly_devices: { message: 'pg down' } } })
    const res = await PATCH(patchReq({ enabled: false }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect((await res.json()).notice).toBe(GROUP_DISABLE_NOTICE)
  })

  it('DELETE: the message gains the time, read from the members BEFORE the delete', async () => {
    useDb(withMembers({}, [armed]))
    const body = await (await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))).json()
    expect(body.message).toBe(`${GROUP_DELETED_MESSAGE}${SENTENCE}`)
    useDb(withMembers({}, []))
    expect((await (await DELETE(req(URL, { method: 'DELETE' }), ctxFor(GRP_A))).json()).message).toBe(GROUP_DELETED_MESSAGE)
  })
})
