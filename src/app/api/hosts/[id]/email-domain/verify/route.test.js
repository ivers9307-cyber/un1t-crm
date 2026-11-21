// POST /api/hosts/[id]/email-domain/verify through the real withAuth wrapper (a
// staff session, not the host portal): signed in (the same 401), Manager+
// (403), the active organisation, the host in it (404 otherwise); then the
// Postmark re-check or the kill switch.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, ORG } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/postmark-domains', async (importOriginal) => ({
  ...(await importOriginal()),
  getDomain: vi.fn(),
  verifyDkim: vi.fn(async () => ({})),
  verifyReturnPath: vi.fn(async () => ({})),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { getDomain } = await import('@/lib/postmark-domains')
const { POST } = await import('./route.js')

const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000f9'
const HOST = 'b2000000-0000-4000-8000-0000000000a1'
const HOST_FAR = 'b2000000-0000-4000-8000-0000000000f1'
const verify = (id, body) => POST(new Request(`http://localhost/api/hosts/${id}/email-domain/verify`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), { params: Promise.resolve({ id }) })
const roleAtA = (role) => person({ [LOC_A]: { role }, [LOC_B]: { role: 'staff' } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    event_hosts: [
      { id: HOST, organization_id: ORG, name: 'Acme', sender_domain: 'mail.acme.test', sender_email: 'hi@mail.acme.test', slug: 'acme', postmark_domain_id: 77, sender_domain_verified: false },
      { id: HOST_FAR, organization_id: OTHER_ORG, name: 'Far', sender_domain: 'mail.far.test', postmark_domain_id: 78, sender_domain_verified: true },
    ],
  } })
  createServerClient.mockReturnValue(db)
  getDomain.mockResolvedValue({ DKIMVerified: true, ReturnPathDomainVerified: true })
})

describe('POST /api/hosts/[id]/email-domain/verify', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await verify(HOST)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 below Manager', async () => {
    getCurrentUser.mockResolvedValue(roleAtA('staff'))
    expect((await verify(HOST)).status).toBe(403)
    expect(getDomain).not.toHaveBeenCalled()
  })

  it("404 for another organisation's host, Postmark never asked", async () => {
    getCurrentUser.mockResolvedValue(roleAtA('manager'))
    expect((await verify(HOST_FAR, { verified: false })).status).toBe(404)
    expect(db.tables.event_hosts[1].sender_domain_verified).toBe(true)
    expect(getDomain).not.toHaveBeenCalled()
  })

  it('stamps verified from Postmark', async () => {
    getCurrentUser.mockResolvedValue(roleAtA('manager'))
    const res = await verify(HOST)
    expect(res.status).toBe(200)
    expect((await res.json()).data.verified).toBe(true)
    expect(db.tables.event_hosts[0].sender_domain_verified).toBe(true)
  })

  it("a Postmark failure is a 502 without Postmark's text", async () => {
    getCurrentUser.mockResolvedValue(roleAtA('owner'))
    getDomain.mockRejectedValueOnce(new Error('postmark internal detail'))
    const res = await verify(HOST)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the sending domain.' })
  })

  it('the kill switch writes false; a failed write hides the database text', async () => {
    getCurrentUser.mockResolvedValue(roleAtA('owner'))
    db.errors.event_hosts = { update: { message: 'secret db text' } }
    const res = await verify(HOST, { verified: false })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
