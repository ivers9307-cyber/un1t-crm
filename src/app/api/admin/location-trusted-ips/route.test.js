// Route test for adding a trusted studio IP.
//
// Focus: the location_trusted_ip.added audit event must NOT pass the
// location_trusted_ips UUID as target.id (audit_events.target_profile_id
// FK → profiles — a non-profile UUID silently drops the row). Row identity
// rides in target.resource ('location_trusted_ips/<id>').

import { describe, it, expect, vi, beforeEach } from 'vitest'

let results = {}
function makeBuilder(result) {
  const b = {}
  for (const m of ['select', 'eq', 'insert', 'order']) b[m] = () => b
  b.single = () => Promise.resolve(result)
  b.then = (resolve) => Promise.resolve(result).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(results[t] ?? { data: null, error: null }) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MASTER = { id: 'prof-master', full_name: 'Max Master', email: 'max@un1t.ie', profileRole: 'master' }

function req(body) {
  return { json: async () => body, headers: { get: () => null } }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
  results = {
    location_trusted_ips: {
      data: {
        id: 'ip-1', location_id: LOC, ip_cidr: '203.0.113.0/24',
        label: 'Studio wifi', created_at: '2026-07-17T10:00:00.000Z', created_by: 'prof-master',
      },
      error: null,
    },
  }
})

describe('POST /api/admin/location-trusted-ips', () => {
  it('audits location_trusted_ip.added with a row resource target and no target.id', async () => {
    const res = await POST(req({ location_id: LOC, ip_cidr: '203.0.113.0/24', label: 'Studio wifi' }))
    expect(res.status).toBe(201)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'location_trusted_ip.added',
      actor: expect.objectContaining({ id: 'prof-master' }),
      target: expect.objectContaining({ label: 'Studio wifi', resource: 'location_trusted_ips/ip-1' }),
      locationId: LOC,
    }))
    // Trusted-IP row ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id and violates its FK to profiles.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})
