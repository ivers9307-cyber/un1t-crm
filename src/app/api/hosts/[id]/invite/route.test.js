// W1.L3c — POST /api/hosts/[id]/invite mints the host's set-password link
// (the Supabase invite / recovery `redirectTo`) on the tenant host of the
// host's ANCHOR location, not the CRM host. A NULL anchor (no host-authored
// event yet) floors to the CRM host, and so does a resolver failure: the
// invite is still sent. Depends on Supabase Auth's redirect allow-list
// carrying https://*.repset.ie/** — a non-listed redirectTo is silently
// replaced by the Site URL.
//
// HOSTREINVITE.1 — the already-registered resend branch. admin.generateLink
// only MINTS a recovery link; Supabase sends no email. The route used to
// discard the link and answer "invite re-sent" while the host received
// nothing. The second describe pins that the generated action link is handed
// to the send, and that a failed (or impossible) send never reports success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.repset.ie' }))
vi.mock('@/lib/hosts', async (orig) => ({ ...(await orig()), loadHostForOrg: vi.fn() }))
vi.mock('@/lib/tenant-host', async (orig) => ({ ...(await orig()), resolveCustomerBaseUrl: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/host-portal-access-email', () => ({ sendHostPortalAccessEmail: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostForOrg } from '@/lib/hosts'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { sendHostPortalAccessEmail } from '@/lib/host-portal-access-email'
import { logError } from '@/lib/log'

const HOST_ID = 'h-1'
const ORG_ID = 'org-1'
const MANAGER = { role: 'manager', activeOrganization: { id: ORG_ID } }
const HOST = { id: HOST_ID, organization_id: ORG_ID, email: 'host@example.test', anchor_location_id: 'loc-anchor' }
const ACTION_LINK = 'https://auth.example.test/auth/v1/verify?token=SECRET-TOKEN&type=recovery'

const props = { params: Promise.resolve({ id: HOST_ID }) }
const makeRequest = () => new Request(`http://localhost/api/hosts/${HOST_ID}/invite`, { method: 'POST' })

// A fake service-role client: the invite either succeeds (new auth user, not
// staff, not linked elsewhere) or reports "already registered" (an existing
// portal login for THIS host → recovery link).
function makeDb({ alreadyRegistered = false, linked = true, generate } = {}) {
  const inviteUserByEmail = vi.fn().mockResolvedValue(
    alreadyRegistered
      ? { data: null, error: { message: 'A user with this email address has already been registered' } }
      : { data: { user: { id: 'auth-1' } }, error: null },
  )
  const generateLink = vi.fn(generate || (async () => ({
    data: { properties: { action_link: ACTION_LINK } },
    error: null,
  })))
  const from = vi.fn((table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      upsert: vi.fn().mockResolvedValue({ error: null }),
      maybeSingle: () => Promise.resolve({
        data: table === 'host_users' && alreadyRegistered && linked ? { auth_user_id: 'auth-1' } : null,
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
  sendHostPortalAccessEmail.mockResolvedValue({ messageId: 'pm-1' })
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

describe('POST /api/hosts/[id]/invite — already-registered resend delivers the link (HOSTREINVITE.1)', () => {
  beforeEach(() => {
    loadHostForOrg.mockResolvedValue(HOST)
    resolveCustomerBaseUrl.mockResolvedValue('https://gym-a.repset.ie')
  })

  it('sends the generated action link to the host and reports reinvite', async () => {
    const db = makeDb({ alreadyRegistered: true })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { sentTo: 'host@example.test', kind: 'reinvite' } })
    expect(sendHostPortalAccessEmail).toHaveBeenCalledTimes(1)
    expect(sendHostPortalAccessEmail).toHaveBeenCalledWith({
      db, host: HOST, to: 'host@example.test', url: ACTION_LINK,
    })
  })

  it('does not report success when the email send fails', async () => {
    createServerClient.mockReturnValue(makeDb({ alreadyRegistered: true }))
    sendHostPortalAccessEmail.mockRejectedValue(new Error('Postmark said no'))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/could not be sent/i)
  })

  it('never logs the action link', async () => {
    createServerClient.mockReturnValue(makeDb({ alreadyRegistered: true }))
    sendHostPortalAccessEmail.mockRejectedValue(new Error('Postmark said no'))
    await POST(makeRequest(), props)
    expect(logError).toHaveBeenCalled()
    expect(JSON.stringify(logError.mock.calls)).not.toContain('SECRET-TOKEN')
  })

  it('does not report success when generateLink returns no action link', async () => {
    createServerClient.mockReturnValue(makeDb({
      alreadyRegistered: true,
      generate: async () => ({ data: { properties: {} }, error: null }),
    }))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(502)
    expect((await res.json()).success).toBe(false)
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })

  it('surfaces a generateLink error without sending', async () => {
    createServerClient.mockReturnValue(makeDb({
      alreadyRegistered: true,
      generate: async () => ({ data: null, error: { message: 'rate limited' } }),
    }))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'rate limited' })
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })

  it('refuses an existing account that is not this host portal login, without minting a link', async () => {
    const db = makeDb({ alreadyRegistered: true, linked: false })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled()
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })
})
