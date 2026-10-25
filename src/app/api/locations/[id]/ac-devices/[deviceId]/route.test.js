// ACDEVLOC.1 — edit / disable / re-enable a unit at the location in the PATH.
// Replaces PATCH + DELETE /api/studio-management/ac/devices/[id]: PATCH went
// through loadDeviceForUser, which refuses a DISABLED unit (409), so Re-enable
// never worked; DELETE checked nothing but the master role.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual('@/lib/log')
  return { ...actual, logError: vi.fn() }
})

import { PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { LOC_A, LOC_B, MASTER, OUTSIDER, STAFF_A_OWNER_B } from '../../_role-gate-cases.js'

const DEV = 'd0000000-0000-4000-8000-000000000001'

function fakeDb({ existing = { data: { id: DEV, location_id: LOC_B }, error: null }, updated = null } = {}) {
  const calls = []
  const from = (table) => {
    const call = { table, op: 'select', filters: [], payload: null }
    calls.push(call)
    const chain = {
      select: () => chain,
      update: (payload) => { call.op = 'update'; call.payload = payload; return chain },
      eq: (c, v) => { call.filters.push([c, v]); return chain },
      maybeSingle: () => Promise.resolve(existing),
      single: () => Promise.resolve(updated || { data: { id: DEV, location_id: LOC_B, ...call.payload }, error: null }),
    }
    return chain
  }
  return { calls, client: { from } }
}

const patch = (id, deviceId, body) => PATCH(new Request(`http://localhost/api/locations/${id}/ac-devices/${deviceId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id, deviceId }) })
const updateOf = (db) => db.calls.find((c) => c.op === 'update')

describe('PATCH …/ac-devices/[deviceId] (ACDEVLOC.1)', () => {
  let db
  beforeEach(() => { vi.clearAllMocks(); db = fakeDb(); createServerClient.mockReturnValue(db.client); getCurrentUser.mockResolvedValue(MASTER) })

  it('a master with A active edits a unit at B, scoped to B', async () => {
    const res = await patch(LOC_B, DEV, { label: ' New label ' })
    expect(res.status).toBe(200)
    expect(updateOf(db).payload).toEqual({ label: 'New label' })
    expect(updateOf(db).filters).toEqual([['id', DEV], ['location_id', LOC_B]])
    expect((await res.json()).device.label).toBe('New label')
  })

  it('re-enables a disabled unit (the old PATCH refused it with 409)', async () => {
    db = fakeDb({ existing: { data: { id: DEV, location_id: LOC_B, enabled: false }, error: null } })
    createServerClient.mockReturnValue(db.client)
    expect((await patch(LOC_B, DEV, { enabled: true })).status).toBe(200)
    expect(updateOf(db).payload).toEqual({ enabled: true })
  })

  it('disable is enabled:false (a soft disable, never a delete)', async () => {
    expect((await patch(LOC_B, DEV, { enabled: false })).status).toBe(200)
    expect(updateOf(db).payload).toEqual({ enabled: false })
  })

  it('a unit at A addressed through B → 404, nothing written', async () => {
    db = fakeDb({ existing: { data: { id: DEV, location_id: LOC_A }, error: null } })
    createServerClient.mockReturnValue(db.client)
    const res = await patch(LOC_B, DEV, { label: 'x' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(updateOf(db)).toBeUndefined()
  })

  it('identity columns are ignored', async () => {
    await patch(LOC_B, DEV, { label: 'x', provider: 'thinq', location_id: LOC_A, provider_device_id: 'other' })
    expect(updateOf(db).payload).toEqual({ label: 'x' })
  })

  it('an empty patch → 400, nothing read', async () => {
    expect((await patch(LOC_B, DEV, {})).status).toBe(400)
    expect(db.calls).toEqual([])
  })

  it('a device id that is not a uuid → 404, nothing read', async () => {
    expect((await patch(LOC_B, 'not-a-uuid', { label: 'x' })).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('a failed read → logged 500, nothing written', async () => {
    db = fakeDb({ existing: { data: null, error: { message: 'boom' } } })
    createServerClient.mockReturnValue(db.client)
    expect((await patch(LOC_B, DEV, { label: 'x' })).status).toBe(500)
    expect(updateOf(db)).toBeUndefined()
    expect(logError).toHaveBeenCalledWith('ac-devices', 'device read failed', expect.objectContaining({ locationId: LOC_B, deviceId: DEV }))
  })

  it('an owner at B → 403 (master-only); an outsider → 404; nothing read', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await patch(LOC_B, DEV, { label: 'x' })).status).toBe(403)
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await patch(LOC_B, DEV, { label: 'x' })).status).toBe(404)
    expect(db.calls).toEqual([])
  })
})
