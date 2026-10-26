// SHELLYGROUPS.5 — GET/POST /api/shelly/groups.
//
//  1. THE LIST IS SCOPED: the fake holds both studios' groups and devices and
//     filters on the recorded .eq()s, so a dropped location filter fails here.
//  2. `now` is computed by the engine the cron uses, from the location's day.
//  3. A name is unique per studio CASE-INSENSITIVELY (409 name_taken), and a
//     raw 23505 from the UNIQUE index maps to the same answer.

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

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MAX_GROUPS } from '@/lib/shelly/reconcile'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, GRP_A, GRP_B, OWNER_A, STAFF_A, MANAGER_A,
  deviceRow, groupRow, fullState, makeDb, insertsTo, jsonReq, req,
} from '../shelly-routes.test-helpers.js'

const URL = 'http://localhost/api/shelly/groups'
// Monday 24 Aug 2026, 12:00 Dublin (11:00Z).
const NOW = Date.parse('2026-08-24T11:00:00.000Z')
const GRP_A2 = '90000000-0000-4000-8000-0000000000a2'

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
const world = (groups, devices = [], occurrences = []) => ({
  rows: { shelly_groups: groups, shelly_devices: devices, class_occurrences: occurrences },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  getCurrentUser.mockResolvedValue(OWNER_A)
  useDb(world([groupRow(), groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' })]))
})
afterEach(() => vi.useRealTimers())

describe('GET /api/shelly/groups', () => {
  it('lists only the caller’s groups, sorted by sort_order then name, without last_applied', async () => {
    useDb(world([
      groupRow({ id: GRP_A, name: 'Zebra', sort_order: 0, last_applied: { key: 'k' } }),
      groupRow({ id: GRP_A2, name: 'Alpha', sort_order: 1 }),
      groupRow({ id: '90000000-0000-4000-8000-0000000000a3', name: 'Beta', sort_order: 0 }),
      groupRow({ id: GRP_B, location_id: LOC_B, name: 'Theirs' }),
    ]))
    const res = await GET(req(URL, { method: 'GET' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.groups.map((g) => g.name)).toEqual(['Beta', 'Zebra', 'Alpha'])
    expect(body.groups[0]).not.toHaveProperty('last_applied')
    expect(body.groups[0]).not.toHaveProperty('created_by')
    expect(JSON.stringify(body)).not.toContain('Theirs')
  })

  it('carries device_ids and on/member counts from the members’ last readings', async () => {
    useDb(world([groupRow()], [
      deviceRow({ id: DEV_A, group_id: GRP_A, last_state: fullState({ output: true }) }),
      deviceRow({ id: 'd0000000-0000-4000-8000-0000000000a2', device_id: 'aabbcc000002', group_id: GRP_A, last_state: null }),
      deviceRow({ id: 'd0000000-0000-4000-8000-0000000000a3', device_id: 'aabbcc000003', group_id: null }),
      deviceRow({ id: DEV_B, location_id: LOC_B, device_id: 'ffeedd998877', group_id: GRP_A }),
    ]))
    const body = await (await GET(req(URL, { method: 'GET' }))).json()
    expect(body.groups[0].device_ids.sort()).toEqual([DEV_A, 'd0000000-0000-4000-8000-0000000000a2'].sort())
    expect(body.groups[0].now).toMatchObject({ on_count: 1, member_count: 2, mode: 'none' })
  })

  it('describes a fixed group inside its window from the location’s day', async () => {
    useDb(world([groupRow({ enabled: true, schedule_mode: 'fixed', fixed_windows: [{ days: [1], on: '11:00', off: '13:00' }] })]))
    const body = await (await GET(req(URL, { method: 'GET' }))).json()
    // 13:00 Dublin (IST) is 12:00Z.
    expect(body.groups[0].now).toMatchObject({ mode: 'window', until: '2026-08-24T12:00:00.000Z' })
  })

  it('describes a class group from today’s timetable', async () => {
    useDb(world(
      [groupRow({ enabled: true, schedule_mode: 'class', class_rule: { lead_min: 15, lag_min: 10, merge_gap_min: 30, days: [1, 2, 3, 4, 5, 6, 7] } })],
      [],
      [{ location_id: LOC_A, starts_at: '2026-08-24T17:00:00.000Z', ends_at: '2026-08-24T18:00:00.000Z', cancelled_at: null, name: 'HIIT' }],
    ))
    const body = await (await GET(req(URL, { method: 'GET' }))).json()
    expect(body.groups[0].now).toMatchObject({ mode: 'idle', next_on: '2026-08-24T16:45:00.000Z' })
  })

  it('a timetable that cannot be read leaves the list up, marking the class group unread', async () => {
    useDb({ ...world([groupRow({ enabled: true, schedule_mode: 'class', class_rule: {} })]), selectError: { class_occurrences: { message: 'pg down' } } })
    const res = await GET(req(URL, { method: 'GET' }))
    expect(res.status).toBe(200)
    expect((await res.json()).groups[0].now).toMatchObject({ mode: 'idle', windows_unread: true })
  })

  it('500s when the groups cannot be read', async () => {
    useDb({ ...world([]), selectError: { shelly_groups: { message: 'pg down' } } })
    expect((await GET(req(URL, { method: 'GET' }))).status).toBe(500)
  })

  it('403s staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(req(URL, { method: 'GET' }))).status).toBe(403)
  })
})

describe('POST /api/shelly/groups', () => {
  it('creates a group at the caller’s location, recording who made it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await POST(jsonReq({ name: 'Fans', icon: 'fan' }, URL))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.group).toMatchObject({ name: 'Fans', icon: 'fan', location_id: LOC_A, device_ids: [] })
    expect(body.group).not.toHaveProperty('created_by')
    const ins = insertsTo(db, 'shelly_groups')[0]
    expect(ins.payload).toMatchObject({ location_id: LOC_A, name: 'Fans', icon: 'fan', created_by: MANAGER_A.id })
  })

  it('refuses a case-insensitive duplicate name at the same studio with 409 name_taken', async () => {
    const res = await POST(jsonReq({ name: 'gym FLOOR' }, URL))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
    expect(insertsTo(db, 'shelly_groups')).toEqual([])
  })

  it('the same name at ANOTHER studio is fine', async () => {
    const res = await POST(jsonReq({ name: 'Theirs' }, URL))
    expect(res.status).toBe(201)
  })

  it('a name with LIKE wildcards is compared literally', async () => {
    useDb(world([groupRow({ name: 'Fan 1' })]))
    expect((await POST(jsonReq({ name: 'Fan_1' }, URL))).status).toBe(201)
  })

  it('maps a raw 23505 (a race past the check) to the same 409', async () => {
    useDb({ ...world([]), insertError: { shelly_groups: { code: '23505', message: 'duplicate key' } } })
    const res = await POST(jsonReq({ name: 'Fans' }, URL))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('name_taken')
  })

  it('refuses a location_id in the body (strict) and an unknown icon', async () => {
    expect((await POST(jsonReq({ name: 'x', location_id: LOC_B }, URL))).status).toBe(400)
    expect((await POST(jsonReq({ name: 'x', icon: 'rocket' }, URL))).status).toBe(400)
  })

  it('refuses a location already holding the group cap', async () => {
    const many = Array.from({ length: MAX_GROUPS }, (_, i) => groupRow({ id: `90000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `G${i}` }))
    useDb(world(many))
    const res = await POST(jsonReq({ name: 'One more' }, URL))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('group_limit')
  })

  it('403s staff before any write', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(jsonReq({ name: 'x' }, URL))).status).toBe(403)
    expect(insertsTo(db, 'shelly_groups')).toEqual([])
  })
})
