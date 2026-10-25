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

  // ACTIVEUSER.1 (review S1) — deactivation bans the login, and the emailed
  // link of a banned user comes back from GoTrue as an ERROR bounce with no
  // `code`. That used to read "link was not valid", which sends the person
  // round the request-a-link loop forever. The file had no error_code parsing
  // at all until now, so the expired case is pinned with it.
  it('a BANNED user\'s bounce (error_code=user_banned) reads as deactivated, not as a bad link', async () => {
    const res = await GET(req('error=access_denied&error_code=user_banned&error_description=User+is+banned'))
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(loc(res)).toBe('https://crm.test/login?error=account_deactivated')
  })

  it('an EXPIRED link\'s bounce (error_code=otp_expired) still reads as expired', async () => {
    const res = await GET(req('error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(loc(res)).toBe('https://crm.test/login?error=link_expired')
  })

  it('any other error bounce is still link_invalid', async () => {
    const res = await GET(req('error=server_error&error_code=unexpected_failure'))
    expect(loc(res)).toBe('https://crm.test/login?error=link_invalid')
  })

  it('user_banned wins even when a code is present — no exchange is attempted', async () => {
    const res = await GET(req('code=abc123&error_code=user_banned'))
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(loc(res)).toBe('https://crm.test/login?error=account_deactivated')
  })

  it('a ban discovered AT the exchange reads as deactivated too; any other exchange error stays expired', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ data: null, error: { message: 'User is banned', code: 'user_banned' } })
    expect(loc(await GET(req('code=abc123')))).toBe('https://crm.test/login?error=account_deactivated')
    exchangeCodeForSession.mockResolvedValueOnce({ data: null, error: { message: 'invalid code' } })
    expect(loc(await GET(req('code=abc123')))).toBe('https://crm.test/login?error=link_expired')
  })

  it('never throws if exchange throws', async () => {
    exchangeCodeForSession.mockRejectedValueOnce(new Error('network'))
    const res = await GET(req('code=abc123'))
    expect(loc(res)).toContain('/login?error=')
  })
})
