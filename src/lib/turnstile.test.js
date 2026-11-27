import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
const { logWarn, logError } = await import('@/lib/log')
const { refuseUnlessHuman, turnstileConfig, verifyTurnstileToken, TURNSTILE_HEADER } = await import('./turnstile.js')

const req = (token) => new Request('https://crm.example/api/public/leads', {
  method: 'POST',
  headers: token ? { [TURNSTILE_HEADER]: token, 'x-forwarded-for': '1.2.3.4' } : {},
})
const answer = (body, { ok = true, status = 200 } = {}) => vi.fn(async () => ({ ok, status, json: async () => body }))
const ENFORCE = { TURNSTILE_SECRET_KEY: 's', TURNSTILE_MODE: 'enforce' }
const MONITOR = { TURNSTILE_SECRET_KEY: 's', TURNSTILE_MODE: 'monitor' }

beforeEach(() => { vi.mocked(logWarn).mockClear(); vi.mocked(logError).mockClear() })

describe('turnstileConfig (TURNSTILE.1)', () => {
  it('is off with no secret', () => {
    expect(turnstileConfig({})).toMatchObject({ enabled: false, mode: 'off' })
  })
  it('reads enforce and monitor', () => {
    expect(turnstileConfig(ENFORCE).mode).toBe('enforce')
    expect(turnstileConfig(MONITOR).mode).toBe('monitor')
  })
  it('an unknown mode runs as monitor, never enforce', () => {
    const c = turnstileConfig({ TURNSTILE_SECRET_KEY: 's', TURNSTILE_MODE: 'enforced' })
    expect(c.mode).toBe('monitor')
    expect(c.modeIsValid).toBe(false)
  })
})

describe('refuseUnlessHuman (TURNSTILE.1)', () => {
  it('does nothing and calls nobody when not configured', async () => {
    const fetchImpl = vi.fn()
    expect(await refuseUnlessHuman(req(null), 'leads', { env: {}, fetchImpl })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes a good token and sends the secret, token and IP to siteverify', async () => {
    const fetchImpl = answer({ success: true })
    expect(await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl })).toBeNull()
    const form = fetchImpl.mock.calls[0][1].body
    expect(form.get('secret')).toBe('s')
    expect(form.get('response')).toBe('tok')
    expect(form.get('remoteip')).toBe('1.2.3.4')
  })

  it('enforce: refuses a bad token with a 400', async () => {
    const res = await refuseUnlessHuman(req('bad'), 'leads', { env: ENFORCE, fetchImpl: answer({ success: false, 'error-codes': ['invalid-input-response'] }) })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
  })

  it('enforce: refuses a missing token without calling Cloudflare', async () => {
    const fetchImpl = vi.fn()
    const res = await refuseUnlessHuman(req(null), 'leads', { env: ENFORCE, fetchImpl })
    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('monitor: lets a bad token through and logs it', async () => {
    const res = await refuseUnlessHuman(req('bad'), 'leads', { env: MONITOR, fetchImpl: answer({ success: false, 'error-codes': ['invalid-input-response'] }) })
    expect(res).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('turnstile', expect.stringContaining('would refuse'), expect.objectContaining({ form: 'leads' }))
  })

  it('fails OPEN when Cloudflare is down, even in enforce', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network') })
    expect(await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl })).toBeNull()
    expect(await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl: answer({}, { ok: false, status: 503 }) })).toBeNull()
  })

  it('a caller cannot fake an outage: 4xx, unreadable 2xx and malformed tokens fail', async () => {
    expect((await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl: answer({}, { ok: false, status: 400 }) })).status).toBe(400)
    const garbage = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } }))
    expect((await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl: garbage })).status).toBe(400)
    const fetchImpl = vi.fn()
    expect((await refuseUnlessHuman(req('x'.repeat(2049)), 'leads', { env: ENFORCE, fetchImpl })).status).toBe(400)
    expect((await refuseUnlessHuman(req('bad token!'), 'leads', { env: ENFORCE, fetchImpl })).status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a 429 from Cloudflare is an outage and lets through', async () => {
    expect(await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl: answer({}, { ok: false, status: 429 }) })).toBeNull()
  })

  it('a bad SECRET is our mistake: let through, never refuse', async () => {
    const res = await refuseUnlessHuman(req('tok'), 'leads', { env: ENFORCE, fetchImpl: answer({ success: false, 'error-codes': ['invalid-input-secret'] }) })
    expect(res).toBeNull()
  })

  it('logs an error when the mode is misspelt', async () => {
    await refuseUnlessHuman(req('tok'), 'leads', { env: { TURNSTILE_SECRET_KEY: 's', TURNSTILE_MODE: 'on' }, fetchImpl: answer({ success: true }) })
    expect(logError).toHaveBeenCalled()
  })
})

describe('verifyTurnstileToken', () => {
  it('a missing token fails without a request', async () => {
    const fetchImpl = vi.fn()
    expect((await verifyTurnstileToken('', { secret: 's', fetchImpl })).verdict).toBe('fail')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
