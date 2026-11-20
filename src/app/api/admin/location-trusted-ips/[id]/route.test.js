// Route test for removing a trusted studio IP.
//
// Focus: the location_trusted_ip.removed audit event must NOT pass the
// location_trusted_ips UUID as target.id (audit_events.target_profile_id
// FK → profiles — a non-profile UUID silently drops the row). Row identity
// rides in target.resource ('location_trusted_ips/<id>').

import { describe, it, expect, vi, beforeEach } from 'vitest'

let results = {}
function makeBuilder(result) {
  const b = {}
  for (const m of ['select', 'eq', 'delete']) b[m] = () => b
  b.single = () => Promise.resolve(result)
  b.then = (resolve) => Promise.resolve(result).then(resolve)
  return b
}
const fakeDb = { from: (t) => makeBuilder(results[t] ?? { data: null, error: null }) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const MASTER = { id: 'prof-master', full_name: 'Max Master', email: 'max@un1t.ie', profileRole: 'master', isMaster: true, role: 'master' }
const ROW = { id: 'ip-1', location_id: 'loc-1', ip_cidr: '203.0.113.0/24', label: null }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
  results = { location_trusted_ips: { data: ROW, error: null } }
})

describe('DELETE /api/admin/location-trusted-ips/[id]', () => {
  it('audits location_trusted_ip.removed with a row resource target and no target.id', async () => {
    const res = await DELETE({ headers: { get: () => null } }, { params: { id: 'ip-1' } })
    const body = await res.json()
    expect(body).toMatchObject({ success: true })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'location_trusted_ip.removed',
      actor: expect.objectContaining({ id: 'prof-master' }),
      // No label on the row → the CIDR is the display label.
      target: expect.objectContaining({ label: '203.0.113.0/24', resource: 'location_trusted_ips/ip-1' }),
      locationId: 'loc-1',
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })

  // Through the real withAuth wrapper (ROUTEWRAP.R5): masters only.
  const del = () => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'ip-1' }) })

  it('401 signed out (withAuth; it said 403 before), nothing removed', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('403 "Forbidden" for an owner, nothing removed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-owner', role: 'owner', profileRole: 'owner', isMaster: false, locations: [{ id: 'loc-1' }] })
    const res = await del()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('404 for an id that does not exist', async () => {
    results = {}
    const res = await del()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Trusted IP not found' })
  })

  it('a failed write is a 500 without the database text', async () => {
    results = { location_trusted_ips: { data: ROW, error: { message: 'secret detail' } } }
    const res = await del()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
