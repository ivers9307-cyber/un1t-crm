// SHELLYGROUPS.5 — POST /api/shelly/groups/[id]/toggle: the group switch.
//
// GROUP WINS (Richard, 2026-10-26). The order is the contract:
//   1. the group override is written (intent, before any command);
//   2. every member's own device override is cleared;
//   3. ONE set/groups call over the members (switches and lights together);
//   4. each member that landed is stamped with the group override's key;
//   5. members that did not land are reported as pending — the cron applies
//      the group override to them (effectiveTarget carries it).
// An empty group writes the override and sends nothing (Review Focus 1); one
// offline member is `partial` and named (Review Focus 2).

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
vi.mock('@/lib/shelly/reconcile', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runNowForDevice: vi.fn() }
})

import { POST, maxDuration } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import { runNowForDevice } from '@/lib/shelly/reconcile'
import { overrideKey } from '@/lib/shelly/plan'
import { AUTH_ERROR } from '@/lib/shelly/connections'
import { logWarn } from '@/lib/log'
import { MAX_OVERRIDE_HOURS } from '@/lib/shelly/schemas'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, GRP_A, GRP_B, BAD_ID, OWNER_ID, OWNER_A, OWNER_NY, STAFF_A,
  deviceRow, groupRow, connectionRow, fullState, makeDb, updatesTo, selectsFrom, jsonReq, ctxFor,
} from '../../../shelly-routes.test-helpers.js'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const HOUR = 60 * 60 * 1000
const DEV_A2 = 'd0000000-0000-4000-8000-0000000000a2'
const DEV_L = 'd0000000-0000-4000-8000-0000000000a4'
const toggleReq = (body) => jsonReq(body, 'http://localhost/api/shelly/groups/x/toggle')

const devOv = { state: 'off', until: '2026-08-23T20:00:00.000Z', set_by: OWNER_ID, set_at: '2026-08-23T11:00:00.000Z' }
const managedGroup = { enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [7], on: '07:00', off: '21:00' }] }

const world = ({ group = {}, members = null, connections = null } = {}) => ({
  rows: {
    shelly_groups: [groupRow({ ...managedGroup, ...group }), groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' })],
    shelly_devices: [
      ...(members ?? [
        deviceRow({ id: DEV_A, device_id: 'aabbcc000001', channel: 0, group_id: GRP_A, schedule_mode: 'none', fixed_windows: [], override: devOv, last_state: fullState() }),
        deviceRow({ id: DEV_A2, device_id: 'aabbcc000002', channel: 1, group_id: GRP_A, schedule_mode: 'none', fixed_windows: [] }),
      ]),
      // Not a member: must never be touched.
      deviceRow({ id: 'd0000000-0000-4000-8000-0000000000a3', device_id: 'aabbcc000003', group_id: null, override: devOv }),
      deviceRow({ id: DEV_B, location_id: LOC_B, device_id: 'ffeedd998877', group_id: GRP_B, override: devOv }),
    ],
    shelly_connections: connections ?? [connectionRow()],
  },
})

let db
let setGroups
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
function useCloud(result = { ok: true, statusCode: 200, failed: {} }) {
  setGroups = vi.fn().mockResolvedValue(result)
  createShellyClient.mockReturnValue({ setGroups, setSwitch: vi.fn(), setLight: vi.fn() })
}
const grp = () => db.rowsIn('shelly_groups').find((g) => g.id === GRP_A)
const dev = (id) => db.rowsIn('shelly_devices').find((d) => d.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(world())
  useCloud()
  runNowForDevice.mockResolvedValue({ ok: true, action: 'on', reason: 'run_now' })
})
afterEach(() => vi.useRealTimers())

describe('POST …/groups/[id]/toggle — on/off (group wins)', () => {
  it('writes the group override, clears member overrides, sends ONE set/groups, stamps every member', async () => {
    let seenAtSend = null
    setGroups.mockImplementation(async () => {
      seenAtSend = { group: grp().override, a: dev(DEV_A).override }
      return { ok: true, statusCode: 200, failed: {} }
    })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    const body = await res.json()

    // 1 + 2 happened before 3.
    expect(seenAtSend.group).toMatchObject({ state: 'on', set_by: OWNER_ID, set_at: NOW_ISO })
    expect(seenAtSend.a).toBeNull()

    expect(setGroups).toHaveBeenCalledTimes(1)
    expect(setGroups).toHaveBeenCalledWith({ switch: ['aabbcc000001_0', 'aabbcc000002_1'], light: [] }, true)

    const key = overrideKey(grp().override)
    for (const id of [DEV_A, DEV_A2]) {
      expect(dev(id).last_applied).toMatchObject({ key, action: 'on', reason: 'override' })
      expect(dev(id).last_state).toMatchObject({ output: true, source: 'manual' })
    }
    expect(body).toMatchObject({ success: true, applied: 'all', pending_device_ids: [], holds_until_changed: false })
    expect(body.group).toMatchObject({ id: GRP_A, override: { state: 'on' } })
    expect(body.group).not.toHaveProperty('last_applied')

    // Non-members, here and at the other studio, are untouched.
    expect(dev('d0000000-0000-4000-8000-0000000000a3').override).toEqual(devOv)
    expect(dev(DEV_B).override).toEqual(devOv)
    for (const u of updatesTo(db, 'shelly_devices')) expect(u.filters.location_id).toBe(LOC_A)
  })

  it('defaults until to the LOCATION’s next midnight', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    await POST(toggleReq({ state: 'off' }), ctxFor(GRP_A))
    // 2026-08-24 00:00 EDT
    expect(grp().override.until).toBe('2026-08-24T04:00:00.000Z')
  })

  it('takes an explicit until within the cap, and refuses one past it', async () => {
    await POST(toggleReq({ state: 'on', until: new Date(NOW + HOUR).toISOString() }), ctxFor(GRP_A))
    expect(grp().override.until).toBe(new Date(NOW + HOUR).toISOString())
    const res = await POST(toggleReq({ state: 'on', until: new Date(NOW + (MAX_OVERRIDE_HOURS + 1) * HOUR).toISOString() }), ctxFor(GRP_A))
    expect(res.status).toBe(400)
  })

  it('sends switches and lights in the same call', async () => {
    useDb(world({ members: [
      deviceRow({ id: DEV_A, device_id: 'aabbcc000001', group_id: GRP_A }),
      deviceRow({ id: DEV_L, device_id: 'aabbcc000009', channel: 2, kind: 'light', group_id: GRP_A, last_state: fullState({ brightness: 40 }) }),
    ] }))
    await POST(toggleReq({ state: 'off' }), ctxFor(GRP_A))
    expect(setGroups).toHaveBeenCalledWith({ switch: ['aabbcc000001_0'], light: ['aabbcc000009_2'] }, false)
    expect(dev(DEV_L).last_state).toMatchObject({ output: false, brightness: 40 })
  })

  it('one offline member is partial and named; the other is stamped', async () => {
    useCloud({ ok: true, statusCode: 200, failed: { aabbcc000002_1: 'DEVICE_OFFLINE' } })
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ success: true, applied: 'partial', pending_device_ids: [DEV_A2] })
    expect(dev(DEV_A).last_applied).toMatchObject({ action: 'on' })
    expect(dev(DEV_A2).last_applied).toBeNull()
    // The intent is saved for it too: the cron applies the group override.
    expect(grp().override.state).toBe('on')
  })

  it('a failed batch is applied none, everyone pending, and 200', async () => {
    useCloud({ ok: false, kind: 'network', statusCode: 0 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: 'none', pending_device_ids: [DEV_A, DEV_A2], pending: true })
    expect(dev(DEV_A).last_applied).toBeNull()
  })

  it('a rate limit is 429 with the same pending body', async () => {
    useCloud({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ success: true, applied: 'none', code: 'rate_limited' })
  })

  it('a rejected key parks the connection', async () => {
    useCloud({ ok: false, kind: 'auth', statusCode: 401 })
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ applied: 'none', code: 'key_rejected' })
    const conn = db.rowsIn('shelly_connections').find((c) => c.location_id === LOC_A)
    expect(conn).toMatchObject({ status: 'action_needed', last_error: AUTH_ERROR })
  })

  it('a failedCommands key we do not recognise stamps nothing', async () => {
    useCloud({ ok: true, statusCode: 200, failed: { somethingElse: 'X' } })
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ applied: 'none', pending_device_ids: [DEV_A, DEV_A2] })
    expect(dev(DEV_A).last_applied).toBeNull()
  })

  it('an EMPTY group saves the override and makes no cloud call (Review Focus 1)', async () => {
    useDb(world({ members: [] }))
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, applied: 'all', pending_device_ids: [] })
    expect(grp().override.state).toBe('on')
    expect(setGroups).not.toHaveBeenCalled()
  })

  it('an unmanaged group says it holds until changed', async () => {
    useDb(world({ group: { enabled: false, schedule_mode: 'none' } }))
    const body = await (await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))).json()
    expect(body.holds_until_changed).toBe(true)
    expect(body.notice).toEqual(expect.any(String))
  })

  it('a failed group override write refuses, and nothing is sent', async () => {
    db.conf.updateError.shelly_groups = { message: 'pg down' }
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(500)
    expect(setGroups).not.toHaveBeenCalled()
    expect(dev(DEV_A).override).toEqual(devOv)
  })

  it('a failed member-override clear rolls the group override back and refuses before any command', async () => {
    const prior = { state: 'off', until: '2026-08-23T23:00:00.000Z', set_by: OWNER_ID, set_at: '2026-08-23T10:00:00.000Z' }
    useDb(world({ group: { override: prior } }))
    db.conf.updateError.shelly_devices = { message: 'pg down' }
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('member_overrides_not_cleared')
    expect(setGroups).not.toHaveBeenCalled()
    // "Nothing was sent" stays true: the cron has no new group override to apply.
    expect(grp().override).toEqual(prior)
    const rollback = updatesTo(db, 'shelly_groups')[1]
    expect(rollback.filters).toEqual({ id: GRP_A, location_id: LOC_A })
  })

  it('a failed rollback is still a 500, and is logged', async () => {
    db.conf.updateError.shelly_devices = { message: 'pg down' }
    // The first group write (the override) lands; the second (the rollback) fails.
    db.conf.updateError.shelly_groups = () => (updatesTo(db, 'shelly_groups').length > 1 ? { message: 'pg gone' } : null)
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('member_overrides_not_cleared')
    expect(setGroups).not.toHaveBeenCalled()
    expect(logWarn.mock.calls.some(([, msg]) => /rollback failed/.test(msg))).toBe(true)
  })
})

describe('POST …/groups/[id]/toggle — the gates', () => {
  it('404s a foreign group and a malformed id identically, writing nothing', async () => {
    const foreign = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_B))
    const malformed = await POST(toggleReq({ state: 'on' }), ctxFor(BAD_ID))
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await malformed.json())
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
    expect(updatesTo(db, 'shelly_devices')).toEqual([])
    expect(setGroups).not.toHaveBeenCalled()
  })

  it('409s not_connected before any write', async () => {
    useDb(world({ connections: [] }))
    const res = await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(updatesTo(db, 'shelly_groups')).toEqual([])
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(toggleReq({ state: 'on' }), ctxFor(GRP_A))).status).toBe(403)
  })

  it('400s an unknown key', async () => {
    expect((await POST(toggleReq({ state: 'on', hours: 3 }), ctxFor(GRP_A))).status).toBe(400)
  })
})

describe('POST …/groups/[id]/toggle — back to schedule', () => {
  beforeEach(() => {
    useDb(world({ group: { override: { state: 'on', until: '2026-08-23T22:00:00.000Z', set_by: OWNER_ID, set_at: NOW_ISO } } }))
  })

  it('clears the group AND member overrides, then runs each member through the group', async () => {
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(grp().override).toBeNull()
    expect(dev(DEV_A).override).toBeNull()
    expect(runNowForDevice).toHaveBeenCalledTimes(2)
    for (const [, conn, device, deps] of runNowForDevice.mock.calls) {
      expect(conn.locations).toEqual({ timezone: 'Europe/Dublin' })
      expect(device.override).toBeNull()
      expect(deps.group).toMatchObject({ id: GRP_A, override: null })
      // One client shared across members: they share one rate budget.
      expect(typeof deps.makeClient).toBe('function')
    }
    expect(runNowForDevice.mock.calls[0][3].makeClient()).toBe(runNowForDevice.mock.calls[1][3].makeClient())
    expect(body).toMatchObject({ success: true, applied: 'all', pending_device_ids: [] })
    expect(body.results).toEqual([
      { device_id: DEV_A, applied: 'on', reason: 'run_now' },
      { device_id: DEV_A2, applied: 'on', reason: 'run_now' },
    ])
  })

  it('a member that does not take it is partial and named', async () => {
    runNowForDevice
      .mockResolvedValueOnce({ ok: true, action: 'off', reason: 'run_now' })
      .mockResolvedValueOnce({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE' })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ applied: 'partial', pending_device_ids: [DEV_A2] })
    expect(body.results[1]).toMatchObject({ device_id: DEV_A2, applied: null, code: 'device' })
  })

  it('a rejected key stops the run and parks the connection', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'auth' })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(runNowForDevice).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ applied: 'none', pending_device_ids: [DEV_A, DEV_A2] })
    expect(db.rowsIn('shelly_connections').find((c) => c.location_id === LOC_A).status).toBe('action_needed')
  })

  it('a class-mode group reads the timetable ONCE for all its members', async () => {
    const members = [0, 1, 2].map((i) => deviceRow({ id: `d0000000-0000-4000-8000-00000000010${i}`, device_id: `aabbcc00010${i}`, group_id: GRP_A, schedule_mode: 'none', fixed_windows: [] }))
    useDb(world({ members, group: { schedule_mode: 'class', fixed_windows: [], class_rule: { lead_min: 15, lag_min: 10, merge_gap_min: 30, days: [1, 2, 3, 4, 5, 6, 7] } } }))
    db.rowsIn('class_occurrences').push({ location_id: LOC_A, starts_at: '2026-08-23T17:00:00.000Z', ends_at: '2026-08-23T18:00:00.000Z', cancelled_at: null, name: 'HIIT' })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(body.applied).toBe('all')
    expect(selectsFrom(db, 'class_occurrences')).toHaveLength(1)
    expect(runNowForDevice).toHaveBeenCalledTimes(3)
    for (const [, , , deps] of runNowForDevice.mock.calls) {
      const got = await deps.loadOccurrences()
      expect(got).toEqual({ ok: true, occurrences: [expect.objectContaining({ name: 'HIIT' })] })
    }
    expect(selectsFrom(db, 'class_occurrences')).toHaveLength(1)
  })

  it('a timetable that cannot be read for a class-mode group runs nothing and names every member', async () => {
    useDb({ ...world({ group: { schedule_mode: 'class', fixed_windows: [], class_rule: {} } }), selectError: { class_occurrences: { message: 'pg down' } } })
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(runNowForDevice).not.toHaveBeenCalled()
    expect(body).toMatchObject({ applied: 'none', pending_device_ids: [DEV_A, DEV_A2] })
    expect(body.results.every((r) => r.code === 'occurrences')).toBe(true)
  })

  it('a fixed group reads no timetable', async () => {
    await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))
    expect(selectsFrom(db, 'class_occurrences')).toHaveLength(0)
  })

  it('declares a long enough budget for a sequential run', () => {
    expect(maxDuration).toBe(120)
  })

  it('a group with no schedule clears and runs nothing', async () => {
    useDb(world({ group: { enabled: true, schedule_mode: 'none' } }))
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ success: true, applied: null, reason: 'no_schedule', pending_device_ids: [] })
    expect(runNowForDevice).not.toHaveBeenCalled()
    expect(dev(DEV_A).override).toBeNull()
  })

  it('an empty group clears and runs nothing', async () => {
    useDb(world({ members: [] }))
    const body = await (await POST(toggleReq({ state: 'auto' }), ctxFor(GRP_A))).json()
    expect(body).toMatchObject({ applied: 'all', pending_device_ids: [] })
    expect(runNowForDevice).not.toHaveBeenCalled()
    expect(createShellyClient).not.toHaveBeenCalled()
  })
})
