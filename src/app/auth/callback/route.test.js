// MAGIC-LINK.1 — /auth/callback exchanges the PKCE code for a session and lands
// the user authenticated, or bounces to /login with a coarse error. Mirrors the
// proven champ-app callback (PKCE binds the link to the requesting browser).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeCodeForSession = vi.fn(async () => ({ data: { session: { access_token: 't' } }, error: null }))
vi.mock('@/lib/auth', () => ({ createAuthClient: vi.fn(async () => ({ auth: { exchangeCodeForSession } })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { GET } from './route.js'

const req = (qs) => new Request(`https://crm.test/auth/callback?${qs}`)
const loc = (res) => res.headers.get('location')

beforeEach(() => {
  vi.clearAllMocks()
  exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null })
})

describe('GET /auth/callback', () => {
  it('exchanges the code and redirects to the safe next', async () => {
    const res = await GET(req('code=abc123&next=/dashboard'))
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123')
    expect(res.status).toBe(307)
    expect(loc(res)).toBe('https://crm.test/dashboard')
  })

  it('defaults next to /', async () => {
    const res = await GET(req('code=abc123'))
    expect(loc(res)).toBe('https://crm.test/')
  })

  it('rejects an off-origin next (open-redirect guard)', async () => {
    const res = await GET(req('code=abc123&next=//evil.com'))
    expect(loc(res)).toBe('https://crm.test/')
  })

  it('bounces to /login when code is missing — no exchange attempt', async () => {
    const res = await GET(req('next=/dashboard'))
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(loc(res)).toContain('/login?error=link_invalid')
  })

  it('bounces to /login on an exchange error, without leaking the target', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ data: null, error: { message: 'invalid code' } })
    const res = await GET(req('code=bad&next=/dashboard'))
    expect(loc(res)).toContain('/login?error=')
    expect(loc(res)).not.toContain('dashboard')
  })

  it('never throws if exchange throws', async () => {
    exchangeCodeForSession.mockRejectedValueOnce(new Error('network'))
    const res = await GET(req('code=abc123'))
    expect(loc(res)).toContain('/login?error=')
  })
})
