// REPSET-PUB.3A — POST /api/mobile/review-login.
//
// The pure decisions are pinned in src/lib/review-login.test.js. What this
// file pins is the ORDERING and the status codes, because the ordering IS the
// hardening: the limiter must be consulted before the credential check (so
// guessing is throttled whatever email is supplied), the OFF check must come
// before the limiter (so a dormant deploy does no DB work and cannot be probed
// at all), and the not-staff assertion must come before anything is minted. A
// mutation that swaps any two of those blocks fails here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// REPSET-PUB.3A-b — lets one test force the credential gate open while the
// BODY still carries a foreign email, which is the only way to pin "the route
// hands generateLink the CONSTANT, never the caller's string" without the
// assertion being satisfied by the caller's string having been the demo email
// all along.
const gate = vi.hoisted(() => ({ forceMatch: false }))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
}))
vi.mock('@/lib/review-login', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    credentialsMatch: (...args) => (gate.forceMatch ? true : actual.credentialsMatch(...args)),
  }
})

const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const DEMO_EMAIL = 'appreview@un1tdublin.com'
// Fabricated test-only gate code — never the real reviewer code.
const TEST_CODE = 'test-gate-code-1234'

function makeReq({ body, ip, realIp } = {}) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase()
        if (key === 'x-forwarded-for') return ip ?? null
        if (key === 'x-real-ip') return realIp ?? null
        return null
      },
    },
  }
}

// The GoTrue admin namespace as a recording Proxy. Every property resolves to
// a callable, so "createUser is undefined" proves nothing (it was a mock-shape
// assertion, not a behavioural one) — `invoked` records what the route
// ACTUALLY called, and the success test asserts that list is exactly
// ['generateLink'].
function makeAdmin({ generateLink } = {}) {
  const invoked = []
  const calls = []
  const impls = {
    generateLink:
      generateLink ??
      (async () => ({ data: { properties: { email_otp: '12345678' } }, error: null })),
  }
  const admin = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (...args) => {
        invoked.push(prop)
        calls.push({ method: prop, args })
        const impl = impls[prop]
        return impl ? impl(...args) : Promise.resolve({ data: null, error: null })
      }
    },
  })
  return { admin, invoked, calls }
}

// `staffProfiles` is the result of the not-staff assertion's profiles read.
// Default: the invariant holds (no staff rows for the demo address).
function makeDb({ rpc, generateLink, staffProfiles } = {}) {
  const { admin, invoked, calls } = makeAdmin({ generateLink })
  const profilesResult = staffProfiles ?? { data: [], error: null }
  const from = vi.fn(() => ({
    select: () => ({
      ilike: async () => {
        if (profilesResult instanceof Error) throw profilesResult
        return profilesResult
      },
    }),
  }))
  return {
    from,
    rpc: rpc ?? vi.fn(async () => ({ data: true, error: null })),
    auth: { admin },
    adminInvoked: invoked,
    adminCalls: calls,
  }
}

const ORIG_ENV = process.env.REVIEW_LOGIN_CODE
function setCode(value) {
  if (value === undefined) delete process.env.REVIEW_LOGIN_CODE
  else process.env.REVIEW_LOGIN_CODE = value
}

beforeEach(() => {
  vi.clearAllMocks()
  gate.forceMatch = false
  setCode(TEST_CODE)
})
afterEach(() => {
  gate.forceMatch = false
  setCode(ORIG_ENV)
})

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
    expect(db.adminInvoked).toEqual([])
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
    expect(db.adminInvoked).toEqual([])
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

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    // REPSET-PUB.3A-b — this leg comes free from reusing getClientIp
    // (src/lib/rate-limit.js); the local reimplementation dropped it.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, realIp: '198.51.100.7' }))
    expect(db.rpc).toHaveBeenCalledWith('review_login_rate_ok', { p_ip: '198.51.100.7' })
  })

  it('buckets a request with no IP headers as "unknown" rather than skipping the limiter', async () => {
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
    expect(db.adminInvoked).toEqual([])
  })

  it('503s when the rate-limit RPC THROWS (the thenable trap)', async () => {
    // supabase builders are thenables with no .catch — an unguarded rejection
    // here must not fall through to an unthrottled credential check.
    const db = makeDb({ rpc: vi.fn(async () => { throw new Error('network') }) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(503)
    expect(db.adminInvoked).toEqual([])
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

// ── REPSET-PUB.3A-b — the not-staff property is DATA, enforce it at RUNTIME ──
//
// The demo account is safe only because someone deleted its profiles rows in
// July (changelog 423). Nothing holds that shape in place: the mig-404
// auto-mint trigger on auth.users INSERT is live, and the demo user's metadata
// carries no `contact_id` / `invited_for` marker, so RECREATING it — which is
// exactly what this route's generateLink error path prescribes to an operator
// — re-mints a role:'staff' profile and a profile_locations row. That
// escalation has already happened in prod once. The assertion below turns the
// data property into a runtime invariant: if a staff profile exists for the
// demo address, the route refuses rather than minting a session that carries
// CRM staff access.
describe('POST /api/mobile/review-login — runtime not-staff assertion', () => {
  it('500s and mints NOTHING when a staff profile exists for the demo address', async () => {
    const db = makeDb({
      staffProfiles: { data: [{ id: 'b1b01190-cfd3-4566-b324-bc42f4794c33', role: 'staff' }], error: null },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    // THE point of the test: no session is minted for an escalated account.
    expect(db.adminInvoked).toEqual([])
  })

  it('logs the refusal structurally, not as free text', async () => {
    const db = makeDb({ staffProfiles: { data: [{ id: 'p1', role: 'manager' }], error: null } })
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(logError).toHaveBeenCalled()
    const meta = logError.mock.calls.at(-1)[2]
    // A stable machine-readable code an alert can match on, plus the offending
    // rows — not a sentence someone has to grep for.
    expect(meta).toMatchObject({ code: 'demo_account_has_staff_profile', profileCount: 1 })
    expect(meta.profileIds).toEqual(['p1'])
    expect(meta.roles).toEqual(['manager'])
  })

  it('refuses on ANY row, whatever the role — the account must have no profile at all', async () => {
    for (const role of ['staff', 'manager', 'master', 'coach', null]) {
      const db = makeDb({ staffProfiles: { data: [{ id: 'p1', role }], error: null } })
      createServerClient.mockReturnValue(db)
      const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
      expect(res.status, `role ${role} must refuse`).toBe(500)
      expect(db.adminInvoked).toEqual([])
    }
  })

  it('fails CLOSED when the profiles read errors — an unreadable invariant is not a satisfied one', async () => {
    const db = makeDb({ staffProfiles: { data: null, error: { message: 'permission denied' } } })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect(db.adminInvoked).toEqual([])
  })

  it('fails CLOSED when the profiles read THROWS (thenable trap again)', async () => {
    const db = makeDb({ staffProfiles: new Error('network') })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect(db.adminInvoked).toEqual([])
  })

  it('runs AFTER the credential check — a stranger cannot probe the demo account for staff rows', async () => {
    const db = makeDb({ staffProfiles: { data: [{ id: 'p1', role: 'staff' }], error: null } })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: 'someone@else.com', code: 'nope' }, ip: '1.2.3.4' }))
    expect(res.status).toBe(403)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('reads the profiles table, keyed on the demo email', async () => {
    // Email is the key, not the user id: the scenario being defended against
    // is the user being DELETED AND RECREATED, which changes the id. The
    // auto-mint trigger writes profiles.email from new.email, so the email is
    // what survives a recreate and identifies the escalated row.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(db.from).toHaveBeenCalledWith('profiles')
  })
})

describe('POST /api/mobile/review-login — success', () => {
  it('mints an OTP for the DEMO account and returns the standard envelope', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: `  ${DEMO_EMAIL.toUpperCase()} `, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { otp: '12345678' } })
  })

  it('hands generateLink the CONSTANT email even when the body carries a foreign one', async () => {
    // REPSET-PUB.3A-b — the previous version of this assertion was
    // tautological: the body's email was the demo email (in some casing), so
    // `email: <normalised body email>` would have satisfied it too. Forcing
    // the credential gate open with a FOREIGN email in the body isolates the
    // property that actually matters — a caller can never steer WHICH account
    // gets a session.
    gate.forceMatch = true
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: 'attacker@evil.com', code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    expect(db.adminInvoked).toEqual(['generateLink'])
    // The recorded call carries the constant, NOT 'attacker@evil.com'.
    expect(db.adminCalls[0].args[0]).toEqual({ type: 'magiclink', email: DEMO_EMAIL })
    expect(JSON.stringify(db.adminCalls)).not.toContain('attacker@evil.com')
  })

  it('calls generateLink and NOTHING ELSE on the admin API', async () => {
    // Behavioural, not shape-based: every property of the admin Proxy is
    // callable, so this fails the moment the route reaches for createUser,
    // deleteUser, updateUserById or anything else.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(db.adminInvoked).toEqual(['generateLink'])
  })

  it('500s (no GoTrue internals) when generateLink errors', async () => {
    const db = makeDb({ generateLink: async () => ({ data: null, error: { message: 'User not found' } }) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('Could not generate login')
    expect(JSON.stringify(body)).not.toContain('User not found')
  })

  it('500s when generateLink succeeds but carries no email_otp', async () => {
    const db = makeDb({ generateLink: async () => ({ data: { properties: {} }, error: null }) })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect((await res.json()).data).toBeUndefined()
  })

  it('the staff-profile refusal is indistinguishable from a mint failure to the caller', async () => {
    createServerClient.mockReturnValue(makeDb({ staffProfiles: { data: [{ id: 'p1', role: 'staff' }], error: null } }))
    const escalated = await (await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))).json()
    createServerClient.mockReturnValue(makeDb({ generateLink: async () => ({ data: null, error: { message: 'boom' } }) }))
    const minted = await (await POST(makeReq({ body: { email: DEMO_EMAIL, code: TEST_CODE }, ip: '1.2.3.4' }))).json()
    expect(escalated).toEqual(minted)
  })
})
