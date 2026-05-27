// STUDIO-PIN.2 — route-level coverage for /api/auth/pin-login.
//
// Lock the auth contract: every gate (unknown device, untrusted IP,
// locked device, wrong PIN, success) produces the right HTTP code,
// the right response shape, AND a pin_login_attempts row with the
// matching outcome value. The actual PIN/device/CIDR primitives have
// their own unit tests; here we lock the orchestration.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'

// STUDIO-PIN.3 — the pin-login route now mints a studio_session
// cookie via studio-session.js, which reads an HMAC secret from env.
// Pin it for the test suite so the mint doesn't throw.
const originalSecret = process.env.STUDIO_SESSION_SECRET
beforeAll(() => { process.env.STUDIO_SESSION_SECRET = 'test-secret' })
afterAll(() => { process.env.STUDIO_SESSION_SECRET = originalSecret })

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/studio-pin', async (orig) => {
  const actual = await orig()
  return { ...actual, findProfileByPin: vi.fn() }
})
vi.mock('@/lib/studio-devices', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    findDeviceByToken: vi.fn(),
    getDeviceLockoutState: vi.fn(),
  }
})
vi.mock('@/lib/trusted-ips', async (orig) => {
  const actual = await orig()
  return { ...actual, isTrustedIpForLocation: vi.fn() }
})

const { createServerClient } = await import('@/lib/supabase')
const { findProfileByPin } = await import('@/lib/studio-pin')
const { findDeviceByToken, getDeviceLockoutState } = await import('@/lib/studio-devices')
const { isTrustedIpForLocation } = await import('@/lib/trusted-ips')
const { POST } = await import('./route.js')

const VALID_TOKEN = 'token-that-is-long-enough-to-pass-min-16'
const VALID_PIN = '4271'
const DEVICE = {
  id: 'dev-1',
  location_id: 'loc-1',
  device_kind: 'mac',
  label: 'Reception Mac',
}
const PROFILE = { id: 'p-1', full_name: 'Alice' }

function buildRequest({ body, ip = '203.0.113.5', ua = 'TestAgent/1.0' } = {}) {
  return new Request('http://test/api/auth/pin-login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      'user-agent': ua,
    },
    body: JSON.stringify(body),
  })
}

let attemptInserts = []

beforeEach(() => {
  attemptInserts = []
  // Mock db: pin_login_attempts.insert collects rows; studio_devices
  // update is fire-and-forget; profiles.select returns the home_screen.
  const db = {
    from(table) {
      if (table === 'pin_login_attempts') {
        return {
          insert: vi.fn(async (row) => {
            attemptInserts.push(row)
            return { data: null, error: null }
          }),
        }
      }
      if (table === 'studio_devices') {
        return {
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        }
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: { home_screen_path: '/schedule' }, error: null,
              }),
            }),
          }),
        }
      }
      return { insert: vi.fn() }
    },
  }
  createServerClient.mockReturnValue(db)

  findDeviceByToken.mockReset()
  findProfileByPin.mockReset()
  getDeviceLockoutState.mockReset()
  isTrustedIpForLocation.mockReset()
})

describe('pin-login — body validation', () => {
  it('400 when device_token missing', async () => {
    const res = await POST(buildRequest({ body: { pin: VALID_PIN } }))
    expect(res.status).toBe(400)
  })

  it('400 when PIN is not 4 digits', async () => {
    const res = await POST(buildRequest({ body: { device_token: VALID_TOKEN, pin: '12' } }))
    expect(res.status).toBe(400)
  })

  it('400 when body is not JSON', async () => {
    const req = new Request('http://test/api/auth/pin-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('pin-login — source IP', () => {
  it('400 when no x-forwarded-for or x-real-ip header', async () => {
    const req = new Request('http://test/api/auth/pin-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_token: VALID_TOKEN, pin: VALID_PIN }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('pin-login — unknown device', () => {
  it('403 when no device matches the token', async () => {
    findDeviceByToken.mockResolvedValue(null)
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN },
    }))
    expect(res.status).toBe(403)
    expect(attemptInserts).toHaveLength(1)
    expect(attemptInserts[0].outcome).toBe('unknown_device')
    expect(attemptInserts[0].device_id).toBe(null)
  })
})

describe('pin-login — untrusted IP', () => {
  it('403 when device matches but IP is outside the location CIDRs', async () => {
    findDeviceByToken.mockResolvedValue(DEVICE)
    isTrustedIpForLocation.mockResolvedValue(false)
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN }, ip: '8.8.8.8',
    }))
    expect(res.status).toBe(403)
    expect(attemptInserts).toHaveLength(1)
    expect(attemptInserts[0].outcome).toBe('untrusted_ip')
    expect(attemptInserts[0].device_id).toBe(DEVICE.id)
  })
})

describe('pin-login — device locked', () => {
  it('429 when the per-device lockout is active', async () => {
    findDeviceByToken.mockResolvedValue(DEVICE)
    isTrustedIpForLocation.mockResolvedValue(true)
    getDeviceLockoutState.mockResolvedValue({
      locked: true,
      recentFailures: 5,
      retryAfter: '2026-06-01T10:15:00Z',
    })
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN },
    }))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.retry_after).toBe('2026-06-01T10:15:00Z')
    expect(attemptInserts).toHaveLength(1)
    expect(attemptInserts[0].outcome).toBe('device_locked')
  })
})

describe('pin-login — wrong PIN', () => {
  it('403 when no profile matches the PIN', async () => {
    findDeviceByToken.mockResolvedValue(DEVICE)
    isTrustedIpForLocation.mockResolvedValue(true)
    getDeviceLockoutState.mockResolvedValue({ locked: false, recentFailures: 0 })
    findProfileByPin.mockResolvedValue(null)
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN },
    }))
    expect(res.status).toBe(403)
    expect(attemptInserts).toHaveLength(1)
    expect(attemptInserts[0].outcome).toBe('wrong_pin')
    expect(attemptInserts[0].matched_profile).toBe(null)
  })
})

describe('pin-login — success', () => {
  it('200 with profile + device + home_screen_path on match', async () => {
    findDeviceByToken.mockResolvedValue(DEVICE)
    isTrustedIpForLocation.mockResolvedValue(true)
    getDeviceLockoutState.mockResolvedValue({ locked: false, recentFailures: 0 })
    findProfileByPin.mockResolvedValue(PROFILE)
    const res = await POST(buildRequest({
      body: { device_token: VALID_TOKEN, pin: VALID_PIN },
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.profile.id).toBe(PROFILE.id)
    expect(json.profile.full_name).toBe(PROFILE.full_name)
    expect(json.profile.home_screen_path).toBe('/schedule')
    expect(json.device.id).toBe(DEVICE.id)
    expect(json.device.kind).toBe('mac')
    expect(attemptInserts).toHaveLength(1)
    expect(attemptInserts[0].outcome).toBe('success')
    expect(attemptInserts[0].matched_profile).toBe(PROFILE.id)
    // STUDIO-PIN.3 — Set-Cookie header carries the signed studio_session
    // cookie. Don't pin the exact value (depends on time + HMAC); just
    // assert shape.
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/^studio_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/)
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Lax/)
  })
})

describe('pin-login — response uniformity', () => {
  it('returns the same error message for wrong-device, wrong-IP, and wrong-PIN', async () => {
    // unknown device
    findDeviceByToken.mockResolvedValueOnce(null)
    const r1 = await POST(buildRequest({ body: { device_token: VALID_TOKEN, pin: VALID_PIN } }))
    const j1 = await r1.json()

    // untrusted IP
    findDeviceByToken.mockResolvedValueOnce(DEVICE)
    isTrustedIpForLocation.mockResolvedValueOnce(false)
    const r2 = await POST(buildRequest({ body: { device_token: VALID_TOKEN, pin: VALID_PIN } }))
    const j2 = await r2.json()

    // wrong PIN
    findDeviceByToken.mockResolvedValueOnce(DEVICE)
    isTrustedIpForLocation.mockResolvedValueOnce(true)
    getDeviceLockoutState.mockResolvedValueOnce({ locked: false, recentFailures: 0 })
    findProfileByPin.mockResolvedValueOnce(null)
    const r3 = await POST(buildRequest({ body: { device_token: VALID_TOKEN, pin: VALID_PIN } }))
    const j3 = await r3.json()

    // All three should be 403 + identical user-facing message.
    expect(r1.status).toBe(403)
    expect(r2.status).toBe(403)
    expect(r3.status).toBe(403)
    expect(j1.error).toBe(j2.error)
    expect(j2.error).toBe(j3.error)
  })
})
