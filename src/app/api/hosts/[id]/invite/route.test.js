// W1.L3c — POST /api/hosts/[id]/invite mints the host's set-password link
// (the Supabase invite / recovery `redirectTo`) on the tenant host of the
// host's ANCHOR location, not the CRM host. A NULL anchor (no host-authored
// event yet) floors to the CRM host, and so does a resolver failure: the
// invite is still sent. Depends on Supabase Auth's redirect allow-list
// carrying https://*.repset.ie/** — a non-listed redirectTo is silently
// replaced by the Site URL.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.repset.ie' }))
vi.mock('@/lib/hosts', async (orig) => ({ ...(await orig()), loadHostForOrg: vi.fn() }))
vi.mock('@/lib/tenant-host', async (orig) => ({ ...(await orig()), resolveCustomerBaseUrl: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostForOrg } from '@/lib/hosts'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'

const HOST_ID = 'h-1'
const ORG_ID = 'org-1'
const MANAGER = { role: 'manager', activeOrganization: { id: ORG_ID } }
const HOST = { id: HOST_ID, organization_id: ORG_ID, email: 'host@example.test', anchor_location_id: 'loc-anchor' }

const props = { params: Promise.resolve({ id: HOST_ID }) }
const makeRequest = () => new Request(`http://localhost/api/hosts/${HOST_ID}/invite`, { method: 'POST' })

// A fake service-role client: the invite either succeeds (new auth user, not
// staff, not linked elsewhere) or reports "already registered" (an existing
// portal login for THIS host → recovery link).
function makeDb({ alreadyRegistered = false } = {}) {
  const inviteUserByEmail = vi.fn().mockResolvedValue(
    alreadyRegistered
      ? { data: null, error: { message: 'A user with this email address has already been registered' } }
      : { data: { user: { id: 'auth-1' } }, error: null },
  )
  const generateLink = vi.fn().mockResolvedValue({ data: {}, error: null })
  const from = vi.fn((table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      upsert: vi.fn().mockResolvedValue({ error: null }),
      maybeSingle: () => Promise.resolve({
        data: table === 'host_users' && alreadyRegistered ? { auth_user_id: 'auth-1' } : null,
        error: null,
      }),
    }
    return chain
  })
  return { from, auth: { admin: { inviteUserByEmail, generateLink } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
})

describe('POST /api/hosts/[id]/invite — set-password link host (W1.L3c)', () => {
  it('mints redirectTo on the tenant host of the anchor location', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    loadHostForOrg.mockResolvedValue(HOST)
    resolveCustomerBaseUrl.mockResolvedValue('https://gym-a.repset.ie')

    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, 'loc-anchor')
    const [email, opts] = db.auth.admin.inviteUserByEmail.mock.calls[0]
    expect(email).toBe('host@example.test')
    expect(opts.redirectTo).toBe('https://gym-a.repset.ie/host/set-password')
  })

  it('the resend (recovery) link uses the same tenant host', async () => {
    const db = makeDb({ alreadyRegistered: true })
    createServerClient.mockReturnValue(db)
    loadHostForOrg.mockResolvedValue(HOST)
    resolveCustomerBaseUrl.mockResolvedValue('https://gym-a.repset.ie')

    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.kind).toBe('reinvite')
    expect(db.auth.admin.generateLink).toHaveBeenCalledWith({
      type: 'recovery',
      email: 'host@example.test',
      options: { redirectTo: 'https://gym-a.repset.ie/host/set-password' },
    })
  })

  it('a NULL anchor floors to the CRM host (real resolver)', async () => {
    const real = await vi.importActual('@/lib/tenant-host')
    resolveCustomerBaseUrl.mockImplementation(real.resolveCustomerBaseUrl)
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    loadHostForOrg.mockResolvedValue({ ...HOST, anchor_location_id: null })

    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, null)
    expect(db.auth.admin.inviteUserByEmail.mock.calls[0][1].redirectTo).toBe('https://crm.repset.ie/host/set-password')
  })

  it('a resolver failure floors to the CRM host and still sends the invite', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    loadHostForOrg.mockResolvedValue(HOST)
    resolveCustomerBaseUrl.mockRejectedValue(new Error('db down'))

    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(db.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1)
    expect(db.auth.admin.inviteUserByEmail.mock.calls[0][1].redirectTo).toBe('https://crm.repset.ie/host/set-password')
  })

  it('404s a host in another org before resolving anything', async () => {
    createServerClient.mockReturnValue(makeDb())
    loadHostForOrg.mockResolvedValue(null)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(404)
    expect(resolveCustomerBaseUrl).not.toHaveBeenCalled()
  })
})
