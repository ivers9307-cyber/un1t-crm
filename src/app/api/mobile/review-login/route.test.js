// REPSET-PUB.3A — POST /api/mobile/review-login.
//
// The pure decisions are pinned in src/lib/review-login.test.js. What this
// file pins is the ORDERING and the status codes, because the ordering IS the
// hardening: the limiter must be consulted before the credential check (so
// guessing is throttled whatever email is supplied) and the OFF check must
// come before the limiter (so a dormant deploy does no DB work and cannot be
// probed at all). A mutation that swaps any two of those three blocks fails
// here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
}))

const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const DEMO_EMAIL = 'appreview@un1tdublin.com'
// Fabricated test-only gate code — never the real reviewer code.
const TEST_CODE = 'test-gate-code-1234'

function makeReq({ body, ip } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
    headers: {
      get: (k) => (String(k).toLowerCase() === 'x-forwarded-for' ? (ip ?? null) : null),
    },
  }
}

function makeDb({ rpc, generateLink } = {}) {
  return {
    rpc: rpc ?? vi.fn(async () => ({ data: true, error: null })),
    auth: {
      admin: {
        generateLink:
          generateLink ??
          vi.fn(async () => ({ data: { properties: { email_otp: '12345678' } }, error: null })),
      },
    },
  }
}

const ORIG_ENV = process.env.REVIEW_LOGIN_CODE
function setCode(value) {
  if (value === undefined) delete process.env.REVIEW_LOGIN_CODE
  else process.env.REVIEW_LOGIN_CODE = value
}

beforeEach(() => {
  vi.clearAllMocks()
  setCode(TEST_CODE)
})
afterEach(() => setCode(ORIG_ENV))

describe('POST /api/mobile/review-login — dormant by default', () => {
  it('404s when REVIEW_LOGIN_CODE is unset — there is NO source fallback', async () => {
    setCode(undefined)
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: 'anything' }, ip: '1.2.3.4' }))
    expect(res.status).toBe(404)
    expect((await res.json()).success).toBe(false)
    // Gated before ANY DB work — a dormant deploy is not even a limiter probe.
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled()
  })

  it('404s on a blank / whitespace-only code (still unconfigured)', async () => {
    for (const value of ['', '   ']) {
      setCode(value)
      const db = makeDb()
      createServerClient.mockReturnValue(db)
      const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: value }, ip: '1.2.3.4' }))
      expect(res.status).toBe(404)
      expect(db.rpc).not.toHaveBeenCalled()
    }
  })

  it('re-reads the env per request — a dormant lambda wakes up when the code is set', async () => {
    // champ captured the code at module load, which on a warm lambda freezes
    // the OFF state until a cold start. Flipping it here must take effect on
    // the very next request.
    setCode(undefined)
    createServerClient.mockReturnValue(makeDb())
    expect((await POST(makeReq({ body: {}, ip: '1.1.1.1' }))).status).toBe(404)

    setCode(TEST_CODE)
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.1.1.1' }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/mobile/review-login — throttle runs BEFORE the credential check', () => {
  it('429s a throttled IP even when the credentials are perfect', async () => {
    const db = makeDb({ rpc: vi.fn(async () => ({ data: false, error: null })) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(429)
    // Nothing was minted.
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled()
  })

  it('counts a WRONG-credential attempt too — the limiter is consulted first', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: 'someone@else.com', code: 'nope' }, ip: '9.9.9.9' }))
    expect(res.status).toBe(403)
    // The attempt was recorded BEFORE the 403 — otherwise guessing is free.
    expect(db.rpc).toHaveBeenCalledWith('review_login_rate_ok', { p_ip: '9.9.9.9' })
  })

  it('passes the FIRST x-forwarded-for hop to the limiter', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '203.0.113.9, 10.0.0.1' }))
    expect(db.rpc).toHaveBeenCalledWith('review_login_rate_ok', { p_ip: '203.0.113.9' })
  })

  it('buckets an absent x-forwarded-for as "unknown" rather than skipping the limiter', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE } }))
    expect(db.rpc).toHaveBeenCalledWith('review_login_rate_ok', { p_ip: 'unknown' })
  })
})

describe('POST /api/mobile/review-login — the limiter fails CLOSED', () => {
  it('503s when the rate-limit RPC returns an error', async () => {
    const db = makeDb({ rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(503)
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled()
  })

  it('503s when the rate-limit RPC THROWS (the thenable trap)', async () => {
    // supabase builders are thenables with no .catch — an unguarded rejection
    // here must not fall through to an unthrottled credential check.
    const db = makeDb({ rpc: vi.fn(async () => { throw new Error('network') }) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(503)
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled()
  })
})

describe('POST /api/mobile/review-login — credentials', () => {
  it('403s on a wrong code', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: 'wrong' }, ip: '1.2.3.4' }))
    expect(res.status).toBe(403)
    expect((await res.json()).success).toBe(false)
  })

  it('403s on any other email, even with the correct code', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(makeReq({ body: { email: 'someone@else.com', code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(403)
  })

  it('403s on an unparseable body rather than treating it as empty-and-equal', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(makeReq({ ip: '1.2.3.4' })) // json() throws
    expect(res.status).toBe(403)
  })

  it('never leaks whether the email or the code was wrong', async () => {
    createServerClient.mockReturnValue(makeDb())
    const a = await (await POST(makeReq({ body: { email: DEMO_EMAIL, code: 'wrong' }, ip: '1.2.3.4' }))).json()
    createServerClient.mockReturnValue(makeDb())
    const b = await (await POST(makeReq({ body: { email: 'x@y.com', code: TEST_CODE }, ip: '1.2.3.4' }))).json()
    expect(a).toEqual(b)
  })
})

describe('POST /api/mobile/review-login — success', () => {
  it('mints an OTP for the DEMO account only and returns the standard envelope', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: `  ${DEMO_EMAIL.toUpperCase()} `, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { otp: '12345678' } })
    // The email is the CONSTANT, never the caller's string — a caller can
    // never steer which account gets a session.
    expect(db.auth.admin.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: DEMO_EMAIL })
  })

  it('never provisions an auth user (signups stay OFF — mig 404)', async () => {
    // champ's route called auth.admin.createUser() first. That is deliberately
    // NOT ported: a public endpoint that can create an account is a bigger
    // surface than one that cannot.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(db.auth.admin.createUser).toBeUndefined()
  })

  it('500s (no GoTrue internals) when generateLink errors', async () => {
    const db = makeDb({ generateLink: vi.fn(async () => ({ data: null, error: { message: 'User not found' } })) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('Could not generate login')
    expect(JSON.stringify(body)).not.toContain('User not found')
  })

  it('500s when generateLink succeeds but carries no email_otp', async () => {
    const db = makeDb({ generateLink: vi.fn(async () => ({ data: { properties: {} }, error: null })) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect((await res.json()).data).toBeUndefined()
  })
})
