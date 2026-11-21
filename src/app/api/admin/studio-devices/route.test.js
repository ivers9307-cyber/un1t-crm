// Route test for studio device pairing.
//
// Focus: the studio_device.paired audit event must NOT pass the
// studio_devices UUID as target.id (audit_events.target_profile_id FK →
// profiles — a non-profile UUID silently drops the row). Device identity
// rides in target.resource ('studio_devices/<id>').

import { describe, it, expect, vi, beforeEach } from 'vitest'

// One result per table: chain methods no-op, .single()/await resolve it.
let results = {}
function makeBuilder(result) {
  const b = {}
  for (const m of ['select', 'eq', 'insert', 'order']) b[m] = () => b
  b.single = () => Promise.resolve(result)
  b.then = (resolve) => Promise.resolve(result).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(results[t] ?? { data: null, error: null }) }

vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/studio-devices', async (importOriginal) => ({
  ...(await importOriginal()),
  generateDeviceToken: vi.fn(() => ({ token: 'cleartext-token', hash: 'sha256-hash' })),
}))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MASTER = { id: 'prof-master', full_name: 'Max Master', email: 'max@un1t.ie', profileRole: 'master', isMaster: true }

function req(body) {
  return new Request('http://localhost/api/admin/studio-devices', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
  results = {
    locations: { data: { id: LOC, name: 'Stillorgan' }, error: null },
    studio_devices: {
      data: { id: 'dev-1', location_id: LOC, device_kind: 'ipad', label: 'Front desk iPad', paired_at: '2026-07-17T10:00:00.000Z' },
      error: null,
    },
  }
})

describe('POST /api/admin/studio-devices', () => {
  it('401 signed out (withAuth; was a 403), nothing paired', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ location_id: LOC, device_kind: 'ipad', label: 'Front desk iPad' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('403s for a non-master', async () => {
    getCurrentUser.mockResolvedValue({ ...MASTER, profileRole: 'owner', isMaster: false })
    const res = await POST(req({ location_id: LOC, device_kind: 'ipad', label: 'Front desk iPad' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('a failed insert answers a fixed 500, never the database text', async () => {
    results.studio_devices = { data: null, error: { message: 'duplicate key value violates unique constraint "studio_devices_pkey"' } }
    const res = await POST(req({ location_id: LOC, device_kind: 'ipad', label: 'Front desk iPad' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not pair the device. Try again.' })
  })

  it('audits studio_device.paired with a device resource target and no target.id', async () => {
    const res = await POST(req({ location_id: LOC, device_kind: 'ipad', label: 'Front desk iPad' }))
    const body = await res.json()
    expect(body).toMatchObject({ success: true, pairing_token: 'cleartext-token' })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'studio_device.paired',
      actor: expect.objectContaining({ id: 'prof-master' }),
      target: expect.objectContaining({ label: 'Front desk iPad', resource: 'studio_devices/dev-1' }),
      locationId: LOC,
    }))
    // Device ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})

describe('GET /api/admin/studio-devices', () => {
  it('401 signed out, 403 for a non-master, the list for a master', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost/api/admin/studio-devices'))).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...MASTER, profileRole: 'owner', isMaster: false })
    expect((await GET(new Request('http://localhost/api/admin/studio-devices'))).status).toBe(403)
    getCurrentUser.mockResolvedValue(MASTER)
    results.studio_devices = { data: [{ id: 'dev-1' }], error: null }
    const res = await GET(new Request('http://localhost/api/admin/studio-devices'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, devices: [{ id: 'dev-1' }] })
  })
})
