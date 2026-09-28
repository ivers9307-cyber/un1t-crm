// ACDEVLOC.1 — GET/POST /api/locations/[id]/ac-devices act on the location in
// the PATH. The settings tab used to list and add through
// /api/studio-management/ac/devices, which acts on the caller's ACTIVE studio:
// a master on Hatch's tab with Stillorgan active saw, and added to,
// Stillorgan. @/lib/auth is REAL; only getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn(async (_db, loc) => loc) }))
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual('@/lib/log')
  return { ...actual, logError: vi.fn() }
})

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import {
  LOC_A, LOC_B, LOC_INACTIVE, MASTER, OUTSIDER, STAFF_A_OWNER_B, MANAGER_A_STAFF_B, MASTER_AS_STAFF_A_MANAGER_B,
} from '../_role-gate-cases.js'

const DEVICE = { id: 'd0000000-0000-4000-8000-000000000001', location_id: LOC_B, label: 'Gym floor', provider: 'sensibo', enabled: true }
const CREDS_B = { id: LOC_B, sensibo_api_key: 'sk-stored-b', thinq_pat: null, thinq_client_id: null, thinq_country_code: null }

// Records every query: table, op, filters, payload.
function fakeDb({ list = { data: [DEVICE], error: null }, creds = { data: CREDS_B, error: null }, insert = null } = {}) {
  const calls = []
  const from = (table) => {
    const call = { table, op: 'select', filters: [], payload: null }
    calls.push(call)
    const chain = {
      select: () => chain,
      insert: (payload) => { call.op = 'insert'; call.payload = payload; return chain },
      eq: (col, val) => { call.filters.push([col, val]); return chain },
      order: () => Promise.resolve(list),
      maybeSingle: () => Promise.resolve(creds),
      single: () => Promise.resolve(insert || { data: { id: 'new-device', ...call.payload }, error: null }),
    }
    return chain
  }
  return { calls, client: { from } }
}

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const get = (id, qs = '') => GET(new Request(`http://localhost/api/locations/${id}/ac-devices${qs}`), ctx(id))
const post = (id, body) => POST(new Request(`http://localhost/api/locations/${id}/ac-devices`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), ctx(id))
const ADD = { provider: 'sensibo', provider_device_id: 'pod-1', label: 'Gym floor' }

describe('GET /api/locations/[id]/ac-devices — the path location (ACDEVLOC.1)', () => {
  let db
  beforeEach(() => { vi.clearAllMocks(); db = fakeDb(); createServerClient.mockReturnValue(db.client) })

  it('a master with A active reads B, not A (the defect)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get(LOC_B)
    expect(res.status).toBe(200)
    expect((await res.json()).devices).toEqual([DEVICE])
    expect(db.calls[0].filters).toContainEqual(['location_id', LOC_B])
    expect(db.calls[0].filters).not.toContainEqual(['location_id', LOC_A])
  })

  it('an owner at B whose active studio is A reads B', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await get(LOC_B)).status).toBe(200)
  })

  it('a member of B who is not owner there → 403, nothing read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    expect((await get(LOC_B)).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('a caller who does not belong to B → 404, nothing read', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await get(LOC_B)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(db.calls).toEqual([])
  })

  it('a master asking for an inactive location → 404', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await get(LOC_INACTIVE)).status).toBe(404)
  })

  it('enabled units only by default (the allowlist picker); ?include_disabled=1 lists all (the settings tab)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    await get(LOC_B)
    expect(db.calls[0].filters).toContainEqual(['enabled', true])
    await get(LOC_B, '?include_disabled=1')
    expect(db.calls[1].filters).not.toContainEqual(['enabled', true])
  })

  it('a failed read is a logged 500, never an empty list', async () => {
    db = fakeDb({ list: { data: null, error: { message: 'boom' } } })
    createServerClient.mockReturnValue(db.client)
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get(LOC_B)
    expect(res.status).toBe(500)
    expect((await res.json()).devices).toBeUndefined()
    expect(logError).toHaveBeenCalledWith('ac-devices', 'list read failed', expect.objectContaining({ locationId: LOC_B }))
  })
})

describe('POST /api/locations/[id]/ac-devices — add at the path location (ACDEVLOC.1)', () => {
  let db
  beforeEach(() => { vi.clearAllMocks(); db = fakeDb(); createServerClient.mockReturnValue(db.client) })

  it('a master with A active adds the unit at B, checking B\'s credentials', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post(LOC_B, ADD)
    expect(res.status).toBe(201)
    expect(db.calls.find((c) => c.table === 'locations').filters).toEqual([['id', LOC_B]])
    expect(db.calls.find((c) => c.op === 'insert').payload).toEqual({
      location_id: LOC_B, provider: 'sensibo', provider_device_id: 'pod-1', label: 'Gym floor', device_group: 'Gym Floor',
    })
    const body = await res.json()
    expect(body.device.location_id).toBe(LOC_B)
    expect(JSON.stringify(body)).not.toContain('sk-stored-b')
  })

  it('an owner at B → 403 (adding a unit is master-only), nothing read', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await post(LOC_B, ADD)).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('a master viewing as someone is judged as that person → 403', async () => {
    getCurrentUser.mockResolvedValue(MASTER_AS_STAFF_A_MANAGER_B)
    expect((await post(LOC_A, ADD)).status).toBe(403)
  })

  it('an outsider → 404, nothing read', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await post(LOC_B, ADD)).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('a bad provider → 400 before any read', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post(LOC_B, { ...ADD, provider: 'daikin' })).status).toBe(400)
    expect(db.calls).toEqual([])
  })

  it('a failed credentials read refuses (500) and inserts nothing', async () => {
    db = fakeDb({ creds: { data: null, error: { message: 'boom' } } })
    createServerClient.mockReturnValue(db.client)
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post(LOC_B, ADD)).status).toBe(500)
    expect(db.calls.some((c) => c.op === 'insert')).toBe(false)
    expect(logError).toHaveBeenCalledWith('ac-devices', 'credentials read failed', expect.objectContaining({ locationId: LOC_B }))
  })

  it('no Sensibo key on B → 412 sensibo_not_configured, nothing inserted', async () => {
    db = fakeDb({ creds: { data: { ...CREDS_B, sensibo_api_key: null }, error: null } })
    createServerClient.mockReturnValue(db.client)
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post(LOC_B, ADD)
    expect(res.status).toBe(412)
    expect((await res.json()).code).toBe('sensibo_not_configured')
    expect(db.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('a unit already at B → 409 duplicate_device', async () => {
    db = fakeDb({ insert: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "ac_devices_location_id_provider_provider_device_id_key"' } } })
    createServerClient.mockReturnValue(db.client)
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post(LOC_B, ADD)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('duplicate_device')
  })
})
