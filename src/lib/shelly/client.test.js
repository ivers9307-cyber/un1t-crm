import { describe, it, expect, vi } from 'vitest'
import {
  normaliseShellyHost, fingerprintAuthKey, keyHint, redactSecret,
  classifyV2, classifyV1, parseGroupsResult, createShellyClient,
  MIN_GAP_MS, RETRY_429_AFTER_MS,
} from './client'

const KEY = 'MTIzNDU2Nzg5MGFiY2RlZg-SECRET-KEY-VALUE'
const conn = { host: 'shelly-103-eu.shelly.cloud', auth_key: KEY }

describe('normaliseShellyHost', () => {
  it('accepts a bare host, a pasted URL, uppercase and whitespace', () => {
    for (const input of ['shelly-103-eu.shelly.cloud', ' https://Shelly-103-EU.shelly.cloud/ ', 'https://shelly-103-eu.shelly.cloud:443/device/status?x=1']) {
      expect(normaliseShellyHost(input)).toEqual({ ok: true, host: 'shelly-103-eu.shelly.cloud' })
    }
  })
  it('rejects anything that is not the account server (SSRF guard)', () => {
    for (const bad of ['shelly-1.shelly.cloud.evil.com', 'evil.com/?h=shelly-1.shelly.cloud', 'localhost', '10.0.0.1', 'api.shelly.cloud', '']) {
      expect(normaliseShellyHost(bad).ok).toBe(false)
    }
  })
  it('drops userinfo, port and path — only the hostname survives', () => {
    expect(normaliseShellyHost('https://user:pw@shelly-1-eu.shelly.cloud:8443/x')).toEqual({ ok: true, host: 'shelly-1-eu.shelly.cloud' })
  })
  it('explains what it wanted without echoing the input back', () => {
    const r = normaliseShellyHost('evil.com')
    expect(r.error).toMatch(/shelly-<region>\.shelly\.cloud/)
    expect(r.error).not.toContain('evil.com')
  })
})

describe('fingerprintAuthKey / keyHint / redactSecret', () => {
  it('fingerprint is 64 hex and stable', () => {
    expect(fingerprintAuthKey(KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintAuthKey(KEY)).toBe(fingerprintAuthKey(KEY))
    expect(fingerprintAuthKey(KEY)).not.toBe(fingerprintAuthKey(KEY + 'x'))
  })
  it('hint is the last four characters', () => {
    expect(keyHint(KEY)).toBe('ALUE')
    expect(keyHint('ab')).toBe('')
  })
  it('redactSecret strips the key out of a message that embeds a URL', () => {
    const e = new Error(`fetch failed for https://x/v2?auth_key=${KEY}`)
    const r = redactSecret(e, KEY)
    expect(r.message).not.toContain(KEY)
    expect(r.message).toContain('[redacted]')
    expect(r.name).toBe('Error')
  })
})

describe('classifiers', () => {
  it('v2: 401/403 and a 2xx UNAUTHORIZED body are auth; 429 is rate_limited', () => {
    expect(classifyV2(401, null)).toBe('auth')
    expect(classifyV2(403, null)).toBe('auth')
    expect(classifyV2(200, { error: 'UNAUTHORIZED' })).toBe('auth')
    expect(classifyV2(429, null)).toBe('rate_limited')
    expect(classifyV2(200, {})).toBe('ok')
    expect(classifyV2(500, null)).toBe('http')
  })
  it('v1: isok:false with invalid_token is auth', () => {
    expect(classifyV1(200, { isok: false, errors: { invalid_token: 'bad' } })).toBe('auth')
    expect(classifyV1(200, { isok: true, data: {} })).toBe('ok')
    expect(classifyV1(200, { isok: false, errors: { other: 'x' } })).toBe('http')
  })
  it('parseGroupsResult maps failedCommands and treats empty bodies as all-ok', () => {
    expect(parseGroupsResult({ failedCommands: { a_0: 'DEVICE_OFFLINE' } })).toEqual({ failed: { a_0: 'DEVICE_OFFLINE' } })
    expect(parseGroupsResult({})).toEqual({ failed: {} })
    expect(parseGroupsResult(null)).toEqual({ failed: {} })
  })
})

function fetchStub(responses) {
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    const r = responses.shift() || { status: 200, body: '' }
    if (r.reject) throw new Error('network down')
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? '' }
  })
  return { fetchImpl, calls }
}

function clockAndSleep(start = 1_000_000) {
  let t = start
  const slept = []
  return {
    now: () => t,
    sleep: vi.fn(async (ms) => { slept.push(ms); t += ms }),
    advance: (ms) => { t += ms },
    slept,
  }
}

describe('createShellyClient', () => {
  it('puts auth_key in the query string, never in the JSON body, and never in results', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify([{ id: 'a8032abe41fc', online: 1 }]) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.get(['a8032abe41fc'])
    expect(res.ok).toBe(true)
    expect(calls[0].url).toBe(`https://shelly-103-eu.shelly.cloud/v2/devices/api/get?auth_key=${encodeURIComponent(KEY)}`)
    expect(calls[0].init.body).not.toContain(KEY)
    expect(JSON.stringify(res)).not.toContain(KEY)
  })

  it('paces consecutive calls at least MIN_GAP_MS apart, and not when the gap already passed', async () => {
    const { fetchImpl } = fetchStub([{ status: 200, body: '[]' }, { status: 200, body: '[]' }, { status: 200, body: '[]' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    await c.get(['a'])
    await c.get(['b'])                       // immediately after → must sleep
    expect(clk.slept[0]).toBeGreaterThanOrEqual(MIN_GAP_MS - 1)
    clk.advance(5000)
    await c.get(['c'])                       // 5s later → no sleep
    expect(clk.slept).toHaveLength(1)
  })

  it('retries a 429 exactly once after RETRY_429_AFTER_MS, then gives up tagged', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 429, body: '' }, { status: 429, body: '' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    const res = await c.get(['a'])
    expect(calls).toHaveLength(2)
    expect(clk.slept).toContain(RETRY_429_AFTER_MS)
    expect(res).toMatchObject({ ok: false, kind: 'rate_limited', retried: true })
  })

  it('maps 401 to auth and a network rejection to network without throwing', async () => {
    const a = createShellyClient(conn, { fetchImpl: fetchStub([{ status: 401, body: '' }]).fetchImpl, ...clockAndSleep() })
    expect(await a.get(['a'])).toMatchObject({ ok: false, kind: 'auth', statusCode: 401 })
    const b = createShellyClient(conn, { fetchImpl: fetchStub([{ reject: true }]).fetchImpl, ...clockAndSleep() })
    expect(await b.get(['a'])).toMatchObject({ ok: false, kind: 'network', statusCode: 0 })
  })

  it('setSwitch: a bare 200 with an empty body is success; a 2xx DEVICE_OFFLINE body is a device failure', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '' }, { status: 200, body: JSON.stringify({ error: 'DEVICE_OFFLINE' }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    expect(await c.setSwitch('a8032abe41fc', 1, true)).toMatchObject({ ok: true })
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: 'a8032abe41fc', channel: 1, on: true })
    expect(await c.setSwitch('a8032abe41fc', 0, false)).toMatchObject({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE' })
  })

  it('setGroups sends the documented body and surfaces failedCommands', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify({ failedCommands: { b_0: 'DEVICE_OFFLINE' } }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.setGroups(['a_0', 'b_0'], false)
    expect(JSON.parse(calls[0].init.body)).toEqual({ switch: { ids: ['a_0', 'b_0'], command: { on: false } } })
    expect(res).toMatchObject({ ok: true, failed: { b_0: 'DEVICE_OFFLINE' } })
  })

  it('allStatus is the v1 form-encoded call and classifies invalid_token as auth', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify({ isok: false, errors: { invalid_token: 'x' } }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.allStatus()
    expect(calls[0].url).toBe('https://shelly-103-eu.shelly.cloud/device/all_status')
    expect(calls[0].init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0].init.body).toContain('show_info=true')
    expect(calls[0].init.body).toContain('no_shared=true')
    expect(res).toMatchObject({ ok: false, kind: 'auth' })
  })
})
