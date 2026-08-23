import { describe, it, expect, vi } from 'vitest'
import {
  normaliseShellyHost, fingerprintAuthKey, keyHint, redactSecret,
  classifyV2, classifyV1, parseGroupsResult, createShellyClient,
  MIN_GAP_MS, RETRY_429_AFTER_MS, MAX_GET_IDS,
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
  it('a blank key has no fingerprint — never a valid-looking digest', () => {
    for (const blank of ['', null, undefined]) expect(fingerprintAuthKey(blank)).toBe('')
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
  it('redacts the PERCENT-ENCODED key too — base64-ish keys carry + / =', () => {
    // This key never appears raw in a URL: encodeURIComponent turns + / =
    // into %2B %2F %3D, so raw-only redaction would leak it whole.
    const secret = 'abc+def/ghi=='
    const e = new Error(`fetch failed for https://h/v2/devices/api/get?auth_key=${encodeURIComponent(secret)}`)
    const r = redactSecret(e, secret)
    expect(r.message).not.toContain(encodeURIComponent(secret))
    expect(r.message).not.toContain(secret)
    expect(r.message).toContain('[redacted]')
  })
  it('also redacts the FORM-encoded form, which is not encodeURIComponent', () => {
    // The v1 body is form-encoded: space becomes + and ~!'() get escaped,
    // neither of which encodeURIComponent does. A key with those characters
    // has three distinct on-the-wire forms.
    const secret = "ab~c!d e"
    const formEncoded = new URLSearchParams([['k', secret]]).toString().slice(2)
    expect(formEncoded).not.toBe(encodeURIComponent(secret))
    const r = redactSecret(new Error(`POST body auth_key=${formEncoded}&show_info=true`), secret)
    expect(r.message).not.toContain(formEncoded)
    expect(r.message).toBe('POST body auth_key=[redacted]&show_info=true')
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

  // The distinction the reconcile stamps on: {} is "nothing failed", null is
  // "unreadable". A shape that folds to {} claims every command landed.
  it('parseGroupsResult reports an unreadable failedCommands as null, never as all-ok', () => {
    expect(parseGroupsResult({ failedCommands: 'none' })).toEqual({ failed: null })
    expect(parseGroupsResult({ failedCommands: 0 })).toEqual({ failed: null })
    expect(parseGroupsResult({ failedCommands: true })).toEqual({ failed: null })
    // An array spreads to { 0: 'a_0' } — index keys match no group id, so it
    // would read as all-ok while naming a failure.
    expect(parseGroupsResult({ failedCommands: ['a_0'] })).toEqual({ failed: null })
    // Absent and explicit-null stay all-ok: that IS the documented success body.
    expect(parseGroupsResult({ failedCommands: null })).toEqual({ failed: {} })
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

  it('serialises un-awaited calls, so concurrency cannot skip the gap', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '["a"]' }, { status: 200, body: '["b"]' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    // Fired together, never awaited individually — the read-then-write gap
    // check alone would let both through with no sleep at all.
    await Promise.all([c.get(['a']), c.get(['b'])])
    expect(calls).toHaveLength(2)
    expect(clk.slept).toHaveLength(1)
    expect(clk.slept[0]).toBeGreaterThanOrEqual(MIN_GAP_MS - 1)
    // …and they went out in the order they were queued.
    expect(JSON.parse(calls[0].init.body).ids).toEqual(['a'])
    expect(JSON.parse(calls[1].init.body).ids).toEqual(['b'])
  })

  it('get refuses more than ten ids instead of silently slicing, and never spends a request', async () => {
    const { fetchImpl, calls } = fetchStub([])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const ids = Array.from({ length: MAX_GET_IDS + 1 }, (_, i) => `d${i}`)
    expect(await c.get(ids)).toEqual({ ok: false, kind: 'too_many_ids', statusCode: 0, count: MAX_GET_IDS + 1 })
    expect(calls).toHaveLength(0)
  })

  it('exactly MAX_GET_IDS ids is allowed — the boundary is inclusive', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '[]' }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const ids = Array.from({ length: MAX_GET_IDS }, (_, i) => `d${i}`)
    expect(await c.get(ids)).toMatchObject({ ok: true })
    expect(JSON.parse(calls[0].init.body).ids).toHaveLength(MAX_GET_IDS)
  })

  it('get with a non-array id list is a caller bug, not an empty request', async () => {
    const { fetchImpl, calls } = fetchStub([])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    for (const bad of ['a8032abe41fc', 42, { ids: ['a'] }]) {
      expect(await c.get(bad)).toEqual({ ok: false, kind: 'invalid_ids', statusCode: 0 })
    }
    expect(calls).toHaveLength(0)
  })

  it('defaults select to status only — the cron never reads settings', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '[]' }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    await c.get(['a'])
    expect(JSON.parse(calls[0].init.body).select).toEqual(['status'])
  })

  it('get short-circuits an empty or missing id list without spending a request', async () => {
    const { fetchImpl, calls } = fetchStub([])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    expect(await c.get([])).toEqual({ ok: true, statusCode: 0, body: [] })
    expect(await c.get()).toEqual({ ok: true, statusCode: 0, body: [] })
    expect(calls).toHaveLength(0)
  })

  // A 2xx whose body is an error object, not the documented array. Left as ok
  // it reaches the reconcile as an empty item list — "the account answered and
  // mentioned nobody" — which writes every device offline and still stamps the
  // connection connected.
  it('get: a 2xx error body is a failure, not an empty reading list', async () => {
    const { fetchImpl } = fetchStub([
      { status: 200, body: JSON.stringify({ error: 'DEVICE_NOT_FOUND' }) },
      { status: 200, body: JSON.stringify([{ id: 'a8032abe41fc', online: 1 }]) },
    ])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    // 'http', not 'device': the read path's black-hole stop and the
    // "Shelly unreachable (kind)" copy are written against the kinds get yields.
    expect(await c.get(['a8032abe41fc'])).toMatchObject({ ok: false, kind: 'http', code: 'DEVICE_NOT_FOUND' })
    // The normal array body is untouched.
    expect(await c.get(['a8032abe41fc'])).toMatchObject({ ok: true, statusCode: 200, body: [{ id: 'a8032abe41fc', online: 1 }] })
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

  it('a 429 that succeeds on the retry is ok, and still says it cost two requests', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 429, body: '' }, { status: 200, body: JSON.stringify([{ id: 'a' }]) }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep })
    const res = await c.get(['a'])
    expect(calls).toHaveLength(2)
    expect(res).toMatchObject({ ok: true, retried: true, statusCode: 200 })
    expect(res.body).toEqual([{ id: 'a' }])
  })

  it('honours an injected minGapMs for BOTH the pacing gap and the 429 retry sleep', async () => {
    const { fetchImpl } = fetchStub([{ status: 200, body: '[]' }, { status: 429, body: '' }, { status: 200, body: '[]' }])
    const clk = clockAndSleep()
    const c = createShellyClient(conn, { fetchImpl, now: clk.now, sleep: clk.sleep, minGapMs: 2000 })
    await c.get(['a'])
    const res = await c.get(['b'])
    // 2000 for the gap, then 2000 again for the retry — a fixed 1100 ms
    // retry would have undercut the slower budget that was asked for.
    expect(clk.slept).toEqual([2000, 2000])
    expect(res).toMatchObject({ ok: true, retried: true })
  })

  it('carries retried through a result a method rewrites into another tag', async () => {
    const offline = clockAndSleep()
    const a = createShellyClient(conn, {
      fetchImpl: fetchStub([{ status: 429, body: '' }, { status: 200, body: JSON.stringify({ error: 'DEVICE_OFFLINE' }) }]).fetchImpl,
      now: offline.now, sleep: offline.sleep,
    })
    expect(await a.setSwitch('a', 0, true)).toMatchObject({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE', retried: true })

    const grouped = clockAndSleep()
    const b = createShellyClient(conn, {
      fetchImpl: fetchStub([{ status: 429, body: '' }, { status: 200, body: JSON.stringify({ failedCommands: { b_0: 'DEVICE_OFFLINE' } }) }]).fetchImpl,
      now: grouped.now, sleep: grouped.sleep,
    })
    expect(await b.setGroups(['b_0'], true)).toMatchObject({ ok: true, retried: true, failed: { b_0: 'DEVICE_OFFLINE' } })
  })

  it('maps 401 to auth and a network rejection to network without throwing', async () => {
    const a = createShellyClient(conn, { fetchImpl: fetchStub([{ status: 401, body: '' }]).fetchImpl, ...clockAndSleep() })
    expect(await a.get(['a'])).toMatchObject({ ok: false, kind: 'auth', statusCode: 401 })
    const b = createShellyClient(conn, { fetchImpl: fetchStub([{ reject: true }]).fetchImpl, ...clockAndSleep() })
    expect(await b.get(['a'])).toMatchObject({ ok: false, kind: 'network', statusCode: 0 })
  })

  it('a response object with no .text() is tagged, not thrown past the boundary', async () => {
    // An un-awaited call that throws here would be an unhandled rejection,
    // which is process-fatal on Node >= 15 — so response handling must be
    // inside the try, not just the fetch.
    const c = createShellyClient(conn, { fetchImpl: async () => ({ ok: true, status: 200 }), ...clockAndSleep() })
    await expect(c.get(['a'])).resolves.toEqual({ ok: false, kind: 'http', statusCode: 200, body: null })
  })

  it('a fetch that resolves undefined is tagged, not thrown', async () => {
    const c = createShellyClient(conn, { fetchImpl: async () => undefined, ...clockAndSleep() })
    await expect(c.get(['a'])).resolves.toEqual({ ok: false, kind: 'http', statusCode: 0, body: null })
  })

  it('the recovery path is itself total — a throwing status getter does not escape', async () => {
    // Reading res.status inside the catch would re-throw here, i.e. a
    // recovery path failing louder than the thing it recovers from.
    const c = createShellyClient(conn, {
      fetchImpl: async () => ({ get status() { throw new Error('boom') }, text: async () => '' }),
      ...clockAndSleep(),
    })
    await expect(c.get(['a'])).resolves.toEqual({ ok: false, kind: 'http', statusCode: 0, body: null })
  })

  it('a body read that fails is an http failure, not a successful empty response', async () => {
    const c = createShellyClient(conn, {
      fetchImpl: async () => ({ status: 200, text: async () => { throw new Error('stream died') } }),
      ...clockAndSleep(),
    })
    await expect(c.get(['a'])).resolves.toEqual({ ok: false, kind: 'http', statusCode: 200, body: null })
  })

  it('a host that fails the SSRF guard makes every method a config failure, with no fetch', async () => {
    // probeConnection tests a PASTED connection that the column CHECK has
    // never seen, so the client cannot assume its host was validated.
    const { fetchImpl, calls } = fetchStub([])
    const c = createShellyClient({ host: 'evil.example/collect?x=', auth_key: KEY }, { fetchImpl, ...clockAndSleep() })
    const results = [
      await c.get(['a']), await c.get([]), await c.get(),
      await c.setSwitch('a', 0, true), await c.setGroups(['a_0'], true), await c.allStatus(),
    ]
    for (const r of results) expect(r).toEqual({ ok: false, kind: 'config', statusCode: 0 })
    expect(calls).toHaveLength(0)
  })

  it('a pasted-URL host is normalised before it ever reaches the request', async () => {
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: '[]' }])
    const c = createShellyClient({ host: ' https://Shelly-7-EU.shelly.cloud/x?y=1 ', auth_key: KEY }, { fetchImpl, ...clockAndSleep() })
    await c.get(['a'])
    expect(calls[0].url).toBe(`https://shelly-7-eu.shelly.cloud/v2/devices/api/get?auth_key=${encodeURIComponent(KEY)}`)
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

  it('setGroups: an unreadable failedCommands fails the batch instead of reporting all-ok', async () => {
    const { fetchImpl } = fetchStub([{ status: 200, body: JSON.stringify({ failedCommands: 'nope' }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.setGroups(['a_0', 'b_0'], true)
    expect(res).toMatchObject({ ok: false, kind: 'http', code: 'FAILED_COMMANDS_UNPARSEABLE', statusCode: 200 })
    expect(res.failed).toBeUndefined()
  })

  it('setGroups: a 2xx body carrying an error is a device failure, like setSwitch', async () => {
    const { fetchImpl } = fetchStub([{ status: 200, body: JSON.stringify({ error: 'DEVICE_NOT_FOUND' }) }])
    const c = createShellyClient(conn, { fetchImpl, ...clockAndSleep() })
    const res = await c.setGroups(['a_0'], true)
    expect(res).toMatchObject({ ok: false, kind: 'device', code: 'DEVICE_NOT_FOUND', statusCode: 200 })
    expect(res.failed).toBeUndefined()
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

  it('allStatus carries the key in the ENCODED body and never in the URL', async () => {
    const secret = 'abc+def/ghi=='
    const { fetchImpl, calls } = fetchStub([{ status: 200, body: JSON.stringify({ isok: true, data: {} }) }])
    const c = createShellyClient({ host: 'shelly-103-eu.shelly.cloud', auth_key: secret }, { fetchImpl, ...clockAndSleep() })
    await c.allStatus()
    expect(calls[0].url).not.toContain('auth_key')
    expect(calls[0].url).not.toContain('abc')
    // Form-encoded, so + / = leave as %2B %2F %3D — never in raw form.
    expect(calls[0].init.body).toContain(`auth_key=${encodeURIComponent(secret)}`)
    expect(calls[0].init.body).not.toContain(secret)
  })
})
