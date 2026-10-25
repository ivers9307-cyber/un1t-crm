import { describe, it, expect, vi, beforeEach } from 'vitest'

// ROLESWEEP.1a — the route judges MANAGER_ROLES at the location with the real
// per-location helpers, so the fixtures carry rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return { getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), hasRoleAtLocation, hasRoleAtAnyLocation }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/screen-doorbell', () => ({ ringScreens: vi.fn(async () => 1) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ringScreens } from '@/lib/screen-doorbell'
import { logWarn } from '@/lib/log'
import { PACKAGE_NAME_MAX } from '@/lib/screen-mode'

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

// SCREENMODE.4 — screen_mode's config names fleet_devices rows (Android TV
// boxes) by device_name. The boxes act on what the CRM stores, so a name from
// another studio, a non-screen device, or a package name that is shell text must
// never be written. The fake records every op, so the assertions check what was
// (not) read or written rather than the mocks.
describe('PUT /api/automations/screen_mode — config validation', () => {
  const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
  const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
  const FLEET = [
    { device_name: 'hatch-screen1', location_id: LOC_A, role: 'screen' },
    { device_name: 'hatch-screen2', location_id: LOC_A, role: 'screen' },
    { device_name: 'hatch-kiosk', location_id: LOC_A, role: 'kiosk' },
    { device_name: 'stillorgan-tv1', location_id: LOC_B, role: 'screen' },
  ]
  const KEY = 'screen_mode'
  const PKG = 'com.franchise.app'

  function managerAtA() {
    getCurrentUser.mockResolvedValue({ role: 'manager', id: 'u1', rolesByLocation: { [LOC_A]: 'manager' } })
  }

  // ac_devices is deliberately not handled: a screen_mode write that touches it
  // throws "unexpected table", which fails the test.
  function fakeDb({ fleetError = null, prior = null, priorError = null } = {}) {
    const ops = []
    const from = (table) => {
      if (table === 'fleet_devices') {
        const filters = { eq: {}, in: {} }
        const q = {
          select: (cols) => { filters.columns = cols; return q },
          eq: (col, val) => { filters.eq[col] = val; return q },
          in: (col, vals) => { filters.in[col] = vals; return q },
          then: (resolve) => {
            ops.push({ table, op: 'select', filters })
            if (fleetError) return resolve({ data: null, error: fleetError })
            const data = FLEET
              .filter((d) => Object.entries(filters.eq).every(([c, v]) => d[c] === v))
              .filter((d) => Object.entries(filters.in).every(([c, vs]) => vs.includes(d[c])))
              .map((d) => ({ device_name: d.device_name }))
            return resolve({ data, error: null })
          },
        }
        return q
      }
      if (table === 'location_automations') {
        return {
          select: (cols) => {
            const filters = { columns: cols, eq: {} }
            const q = {
              eq: (col, val) => { filters.eq[col] = val; return q },
              maybeSingle: async () => {
                ops.push({ table, op: 'select', filters })
                return priorError ? { data: null, error: priorError } : { data: prior, error: null }
              },
            }
            return q
          },
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

  const upserts = (ops) => ops.filter((o) => o.op === 'upsert')
  const fleetReads = (ops) => ops.filter((o) => o.table === 'fleet_devices')

  it('refuses a device name that is not a screen at this studio, without echoing it', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1', 'stillorgan-tv1'], class_app_package: 'com.franchise.app' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'unknown_device' })
    expect(upserts(ops)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('refuses a device at this studio whose role is not screen', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-kiosk'], class_app_package: PKG } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_device')
    expect(upserts(ops)).toHaveLength(0)
  })

  it('scopes the device read to the location and the screen role', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    const [read] = fleetReads(ops)
    expect(read.filters.columns).toBe('device_name')
    expect(read.filters.eq).toEqual({ location_id: LOC_A, role: 'screen' })
    expect(read.filters.in).toEqual({ device_name: ['hatch-screen1'] })
  })

  it('refuses a package name with shell characters, before any fleet_devices read', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: 'com.x; reboot' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_package_name')
    expect(fleetReads(ops)).toHaveLength(0)
    expect(upserts(ops)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('refuses a package name that is not a string, and one longer than the cap', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const notString = await put({ location_id: LOC_A, enabled: true, config: { class_app_package: ['com.franchise.app'] } })
    expect(notString.status).toBe(400)
    expect((await notString.json()).error).toBe('bad_package_name')
    const tooLong = await put({ location_id: LOC_A, enabled: true, config: { class_app_package: `com.${'a'.repeat(PACKAGE_NAME_MAX)}` } })
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).error).toBe('bad_package_name')
    expect(fleetReads(ops)).toHaveLength(0)
    expect(upserts(ops)).toHaveLength(0)
  })

  it('refuses a lead-in or lead-out above 1440 minutes, and accepts exactly 1440', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    for (const config of [{ lead_in_min: 1441 }, { lead_out_min: 1441 }, { lead_in_min: '99999' }]) {
      const res = await put({ location_id: LOC_A, enabled: true, config })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('bad_lead')
    }
    expect(fleetReads(ops)).toHaveLength(0)
    expect(upserts(ops)).toHaveLength(0)
    const ok = await put({ location_id: LOC_A, enabled: false, config: { lead_in_min: 1440, lead_out_min: 1440 } })
    expect(ok.status).toBe(200)
    expect(upserts(ops)[0].row.config).toMatchObject({ lead_in_min: 1440, lead_out_min: 1440 })
  })

  it('400 invalid (not unknown_device) when device_names is malformed, with no reads or writes', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const bad = [
      { device_names: 'hatch-screen1' },
      { device_names: [''] },
      { device_names: ['x'.repeat(101)] },
      { device_names: Array.from({ length: 51 }, (_, i) => `hatch-screen${i}`) },
    ]
    for (const config of bad) {
      const res = await put({ location_id: LOC_A, enabled: true, config })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('bad_device_names')
    }
    expect(ops).toHaveLength(0)
  })

  it('500 and NO upsert when the fleet_devices read fails (never a pass)', async () => {
    managerAtA()
    const { ops, client } = fakeDb({ fleetError: { message: 'boom' } })
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(upserts(ops)).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('stores the resolved config, drops unknown keys, and rings the named screens', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({
      location_id: LOC_A,
      enabled: true,
      config: { device_names: ['hatch-screen1'], class_app_package: 'com.franchise.app', class_filter: ['HYROX'], injected: 'rm -rf /' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    const [up] = upserts(ops)
    expect(up.row).toMatchObject({ location_id: LOC_A, automation_key: KEY, enabled: true })
    expect(up.row.config).toEqual({
      device_names: ['hatch-screen1'],
      class_app_package: 'com.franchise.app',
      lead_in_min: 10,
      lead_out_min: 5,
      class_filter: ['hyrox'],
      excluded_slots: [],
      stale_plan_mode: 'class_app',
    })
    expect(ringScreens).toHaveBeenCalledTimes(1)
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen1'])
  })

  it('never touches ac_devices, and stores a repeated name once', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1', 'hatch-screen1', 'hatch-screen2'], class_app_package: PKG } })
    expect(res.status).toBe(200)
    expect(ops.filter((o) => o.table === 'ac_devices')).toHaveLength(0)
    expect(upserts(ops)[0].row.config.device_names).toEqual(['hatch-screen1', 'hatch-screen2'])
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen1', 'hatch-screen2'])
  })

  it('saves with defaults and no fleet_devices read when no config is sent', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: false })
    expect(res.status).toBe(200)
    expect(fleetReads(ops)).toHaveLength(0)
    expect(upserts(ops)[0].row.config).toMatchObject({ device_names: [], class_app_package: null, lead_in_min: 10 })
  })

  it('a doorbell that throws or rejects never changes the response', async () => {
    managerAtA()
    const { client } = fakeDb()
    createServerClient.mockReturnValue(client)
    ringScreens.mockRejectedValueOnce(new Error('realtime down'))
    const rejected = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(rejected.status).toBe(200)
    expect((await rejected.json()).success).toBe(true)
    ringScreens.mockImplementationOnce(() => { throw new Error('sync throw') })
    const thrown = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(thrown.status).toBe(200)
    expect(ringScreens).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('does not ring the screens when the upsert fails', async () => {
    managerAtA()
    createServerClient.mockReturnValue({
      from: (t) => t === 'fleet_devices'
        ? { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [{ device_name: 'hatch-screen1' }], error: null }) }) }) }) }
        : {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
            upsert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'db down' } }) }) }),
          },
    })
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(res.status).toBe(400)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('400 cannot_enable and NO write when enabling without a package name', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'] } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'cannot_enable' })
    expect(ops).toHaveLength(0)
    expect(ringScreens).not.toHaveBeenCalled()
  })

  it('400 cannot_enable and NO write when enabling with no screens chosen', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { class_app_package: PKG, device_names: [] } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('cannot_enable')
    expect(ops).toHaveLength(0)
  })

  it('saving switched off stays unconstrained: an empty config is stored', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: false, config: { device_names: [], class_app_package: null } })
    expect(res.status).toBe(200)
    expect(upserts(ops)).toHaveLength(1)
  })

  it('reads the prior row for this key with the error judged, and rings old and new names once each', async () => {
    managerAtA()
    const { ops, client } = fakeDb({ prior: { config: { device_names: ['hatch-screen2', 'hatch-screen1'] } } })
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(res.status).toBe(200)
    const read = ops.find((o) => o.table === 'location_automations' && o.op === 'select')
    expect(read.filters.columns).toBe('config')
    expect(read.filters.eq).toEqual({ location_id: LOC_A, automation_key: KEY })
    expect(ringScreens).toHaveBeenCalledTimes(1)
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen2', 'hatch-screen1'])
    // what is stored is only the new list
    expect(upserts(ops)[0].row.config.device_names).toEqual(['hatch-screen1'])
  })

  it('a failed prior read is logged and the new names are still rung', async () => {
    managerAtA()
    const { client } = fakeDb({ priorError: { message: 'boom' } })
    createServerClient.mockReturnValue(client)
    const res = await put({ location_id: LOC_A, enabled: true, config: { device_names: ['hatch-screen1'], class_app_package: PKG } })
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(ringScreens).toHaveBeenCalledWith(['hatch-screen1'])
  })

  it('leaves the climate keys alone: config is stored exactly as sent, no fleet read, no ring', async () => {
    managerAtA()
    const { ops, client } = fakeDb()
    createServerClient.mockReturnValue(client)
    const res = await PUT(req({ location_id: LOC_A, enabled: true, config: { device_names: ['anything'] } }), { params: Promise.resolve({ key: 'class_climate' }) })
    expect(res.status).toBe(200)
    expect(fleetReads(ops)).toHaveLength(0)
    expect(upserts(ops)[0].row.config).toEqual({ device_names: ['anything'] })
    expect(ringScreens).not.toHaveBeenCalled()
  })
})
