// Route test for studio device revoke.
//
// Focus: the studio_device.revoked audit event must NOT pass the
// studio_devices UUID as target.id (audit_events.target_profile_id FK →
// profiles — a non-profile UUID silently drops the row). Device identity
// rides in target.resource ('studio_devices/<id>').

import { describe, it, expect, vi, beforeEach } from 'vitest'

let results = {}
function makeBuilder(result) {
  const b = {}
  for (const m of ['select', 'eq', 'update']) b[m] = () => b
  b.single = () => Promise.resolve(result)
  b.then = (resolve) => Promise.resolve(result).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(results[t] ?? { data: null, error: null }) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const MASTER = { id: 'prof-master', full_name: 'Max Master', email: 'max@un1t.ie', profileRole: 'master' }
const DEVICE = { id: 'dev-1', location_id: 'loc-1', label: 'Front desk iPad', device_kind: 'ipad', revoked_at: null }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
  results = { studio_devices: { data: DEVICE, error: null } }
})

describe('DELETE /api/admin/studio-devices/[id]', () => {
  it('audits studio_device.revoked with a device resource target and no target.id', async () => {
    const res = await DELETE({ headers: { get: () => null } }, { params: { id: 'dev-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'studio_device.revoked',
      actor: expect.objectContaining({ id: 'prof-master' }),
      target: expect.objectContaining({ label: 'Front desk iPad', resource: 'studio_devices/dev-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
