// POST /api/hosts/[id]/invite — the already-registered resend branch.
//
// admin.generateLink only MINTS a recovery link; Supabase sends no email. The
// route used to discard the link and answer "invite re-sent" while the host
// received nothing. These tests pin that the generated action link is handed
// to the send, and that a failed (or impossible) send never reports success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example.test' }))
vi.mock('@/lib/hosts', async (orig) => ({ ...(await orig()), loadHostForOrg: vi.fn() }))
vi.mock('@/lib/host-portal-access-email', () => ({ sendHostPortalAccessEmail: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostForOrg } from '@/lib/hosts'
import { sendHostPortalAccessEmail } from '@/lib/host-portal-access-email'
import { logError } from '@/lib/log'

const HOST_ID = 'h-1'
const ORG_ID = 'org-1'
const EMAIL = 'host@example.test'
const ACTION_LINK = 'https://auth.example.test/auth/v1/verify?token=SECRET-TOKEN&type=recovery'
const MANAGER = { role: 'manager', activeOrganization: { id: ORG_ID } }
const props = { params: Promise.resolve({ id: HOST_ID }) }

function makeRequest() {
  return new Request(`http://localhost/api/hosts/${HOST_ID}/invite`, { method: 'POST' })
}

// A db whose invite errors "already registered" and whose host_users lookup
// finds this host's existing portal login, i.e. the resend branch.
function makeDb({ link = { auth_user_id: 'u-1' }, generate } = {}) {
  const generateLink = vi.fn(generate || (async () => ({
    data: { properties: { action_link: ACTION_LINK } },
    error: null,
  })))
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: link, error: null }),
  }
  return {
    generateLink,
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(async () => ({
          data: null,
          error: { message: 'A user with this email address has already been registered' },
        })),
        generateLink,
      },
    },
    from: vi.fn(() => chain),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
  loadHostForOrg.mockResolvedValue({ id: HOST_ID, organization_id: ORG_ID, email: EMAIL, name: 'Host Co' })
  sendHostPortalAccessEmail.mockResolvedValue({ messageId: 'pm-1' })
})

describe('POST /api/hosts/[id]/invite, already-registered host login', () => {
  it('sends the generated action link to the host and reports reinvite', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { sentTo: EMAIL, kind: 'reinvite' } })

    expect(db.generateLink).toHaveBeenCalledWith({
      type: 'recovery',
      email: EMAIL,
      options: { redirectTo: 'https://crm.example.test/host/set-password' },
    })
    expect(sendHostPortalAccessEmail).toHaveBeenCalledTimes(1)
    expect(sendHostPortalAccessEmail).toHaveBeenCalledWith({
      db, orgId: ORG_ID, hostId: HOST_ID, to: EMAIL, url: ACTION_LINK,
    })
  })

  it('does not report success when the email send fails', async () => {
    createServerClient.mockReturnValue(makeDb())
    sendHostPortalAccessEmail.mockRejectedValue(new Error('Postmark said no'))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/could not be sent/i)
  })

  it('never logs the action link', async () => {
    createServerClient.mockReturnValue(makeDb())
    sendHostPortalAccessEmail.mockRejectedValue(new Error('Postmark said no'))
    await POST(makeRequest(), props)
    expect(logError).toHaveBeenCalled()
    expect(JSON.stringify(logError.mock.calls)).not.toContain('SECRET-TOKEN')
  })

  it('does not report success when generateLink returns no action link', async () => {
    createServerClient.mockReturnValue(makeDb({ generate: async () => ({ data: { properties: {} }, error: null }) }))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(502)
    expect((await res.json()).success).toBe(false)
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })

  it('surfaces a generateLink error without sending', async () => {
    createServerClient.mockReturnValue(makeDb({ generate: async () => ({ data: null, error: { message: 'rate limited' } }) }))
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'rate limited' })
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })

  it('refuses an existing account that is not this host portal login, without minting a link', async () => {
    const db = makeDb({ link: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(db.generateLink).not.toHaveBeenCalled()
    expect(sendHostPortalAccessEmail).not.toHaveBeenCalled()
  })
})
