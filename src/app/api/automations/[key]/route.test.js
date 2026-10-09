import { describe, it, expect, vi, beforeEach } from 'vitest'

// ROLESWEEP.1a — the route judges MANAGER_ROLES at the location with the real
// per-location helpers, so the fixtures carry rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return { getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), hasRoleAtLocation, hasRoleAtAnyLocation }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function req(body) {
  return { json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
})

describe('PUT /api/automations/[key]', () => {
  it('403 when not a manager+', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'staff' } })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })

  it('400 on an unknown automation key', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'nope' }) })
    expect(res.status).toBe(400)
  })

  it('upserts the toggle and returns success', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { location_id: 'a0000000-0000-0000-0000-000000000001', automation_key: 'glofox_lead_provisioning', enabled: true }, error: null }) }) }))
    createServerClient.mockReturnValue({ from: () => ({ upsert }) })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(upsert).toHaveBeenCalled()
    expect(upsert.mock.calls[0][0]).toMatchObject({ location_id: 'a0000000-0000-0000-0000-000000000001', automation_key: 'glofox_lead_provisioning', enabled: true })
  })

  it('honours the location guard (403 from assertLocationAccess)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const { NextResponse } = await import('next/server')
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    const res = await PUT(req({ location_id: 'b0000000-0000-0000-0000-000000000002', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })
})

// W0.12 — config.device_ids may only name ac_devices rows at body.location_id.
// The climate runners switch whatever ids the config lists with that device's
// OWN location credentials, so a pasted id from another studio would turn on
// another tenant's AC. The fake below records every op so the assertions check
// what was (not) written, not the mocks.
describe('PUT /api/automations/[key] — device ids must belong to the location', () => {
  const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
  const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
  const DEV_A = 'd0000000-0000-0000-0000-00000000000a' // at LOC_A
  const DEV_B = 'd0000000-0000-0000-0000-00000000000b' // at LOC_B
  const DEVICES = [{ id: DEV_A, location_id: LOC_A }, { id: DEV_B, location_id: LOC_B }]
  const KEY = 'class_climate'

  function managerAtA() {
    getCurrentUser.mockResolvedValue({ role: 'manager', id: 'u1', rolesByLocation: { [LOC_A]: 'manager' } })
  }

  // Recording fake: `ops` lists every table op in order; ac_devices selects
  // answer from the fixture (filtered by .eq location_id and .in id).
  function fakeDb({ devicesError = null } = {}) {
    const ops = []
    const from = (table) => {
      if (table === 'ac_devices') {
        const filters = { eq: {}, in: {} }
        const q = {
          select: () => q,
          eq: (col, val) => { filters.eq[col] = val; return q },
          in: (col, vals) => { filters.in[col] = vals; return q },
          then: (resolve) => {
            ops.push({ table, op: 'select', filters })
            if (devicesError) return resolve({ data: null, error: devicesError })
            const data = DEVICES
              .filter((d) => Object.entries(filters.eq).every(([c, v]) => d[c] === v))
              .filter((d) => Object.entries(filters.in).every(([c, vs]) => vs.includes(d[c])))
              .map((d) => ({ id: d.id }))
            return resolve({ data, error: null })
          },
        }
        return q
      }
      if (table === 'location_automations') {
        return {
          upsert: (row, opts) => {
            ops.push({ table, op: 'upsert', row, opts })
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    }
    return { ops, client: { from } }
  }

  function put(body) {
    return PUT(req(body), { params: Promise.resolve({ key: KEY }) })
  }

  it('400 unknown_device and NO upsert when a device id belongs to another location', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_ids: [DEV_B] } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'unknown_device' })
    expect(ops.filter((o) => o.op === 'upsert')).toHaveLength(0)
  })

  it('200 and the upsert carries the config when every device id is at the location', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_ids: [DEV_A], target_c: 19 } })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    const read = ops.find((o) => o.table === 'ac_devices')
    expect(read.filters.eq).toEqual({ location_id: LOC_A })
    expect(read.filters.in).toEqual({ id: [DEV_A] })
    const upserts = ops.filter((o) => o.op === 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].row).toMatchObject({ location_id: LOC_A, automation_key: KEY, enabled: true, config: { device_ids: [DEV_A], target_c: 19 } })
  })

  it('400 and NO upsert when the list mixes an own device with a foreign one', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_ids: [DEV_A, DEV_B] } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_device')
    expect(ops.filter((o) => o.op === 'upsert')).toHaveLength(0)
  })

  it('200 with no ac_devices read when the config has no device_ids', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { target_c: 19 } })
    expect(res.status).toBe(200)
    expect(ops.filter((o) => o.table === 'ac_devices')).toHaveLength(0)
    expect(ops.filter((o) => o.op === 'upsert')).toHaveLength(1)
  })

  it('500 and NO upsert when the ac_devices read fails (never a pass)', async () => {
    managerAtA()
    const { ops, client } = fakeDb({ devicesError: { message: 'boom' } })
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_ids: [DEV_A] } })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(ops.filter((o) => o.op === 'upsert')).toHaveLength(0)
  })

  it('400 validation (not unknown_device) when a device id is not uuid-shaped', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_ids: ['dev-b'] } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toBe('unknown_device')
    expect(ops).toHaveLength(0)
  })
})
