import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendCustomerPush } from './customer-push.js'

// prefRows feeds the contacts.push_prefs lookup (only queried for typed,
// non-'default'-channel payloads); default [] = nobody opted out.
function db(rows, { deleteError = null, prefRows = [], prefError = null } = {}) {
  const deleted = { tokens: null }
  const queried = { contactIds: null, tokenContactIds: null }
  return {
    deleted,
    queried,
    from(table) {
      if (table === 'contacts') {
        return { select() { return { in: (_c, ids) => { queried.contactIds = ids; return Promise.resolve({ data: prefRows, error: prefError }) } } } }
      }
      return {
        select() { return { in: (_c, ids) => { queried.tokenContactIds = ids; return Promise.resolve({ data: rows }) } } },
        delete() { return { in: (_c, toks) => { deleted.tokens = toks; return Promise.resolve({ error: deleteError }) } } },
      }
    },
  }
}
beforeEach(() => { global.fetch = vi.fn() })
afterEach(() => { vi.useRealTimers() })

// Run a send under fake timers so the retry backoff (500ms/2s) doesn't
// slow the suite down.
async function runWithFakeTimers(fn) {
  vi.useFakeTimers()
  const p = fn()
  await vi.runAllTimersAsync()
  return await p
}

describe('sendCustomerPush', () => {
  it('no tokens → sends nothing', async () => {
    expect(await sendCustomerPush(db([]), 'c1', { title: 't', body: 'b' })).toEqual({ sent: 0, invalidated: 0, failed: 0, skipped: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('sends to each token', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) })
    const out = await sendCustomerPush(db([{ id: '1', expo_push_token: 'ExponentPushToken[a]' }]), 'c1', { title: 't', body: 'b', data: { type: 'session_report', session_id: 's1' } })
    expect(out.sent).toBe(1)
    expect(out.failed).toBe(0)
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sent[0]).toMatchObject({ to: 'ExponentPushToken[a]', title: 't', data: { type: 'session_report' } })
  })
  it('prunes DeviceNotRegistered', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) })
    const d = db([{ id: '1', expo_push_token: 'ExponentPushToken[dead]' }])
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.invalidated).toBe(1)
    expect(out.failed).toBe(0) // handled, not a pipeline failure
    expect(d.deleted.tokens).toEqual(['ExponentPushToken[dead]'])
  })
})

describe('sendCustomerPush — push_prefs filter (contacts.push_prefs, mig 350)', () => {
  const ok = (n = 1) => ({ ok: true, json: async () => ({ data: Array.from({ length: n }, () => ({ status: 'ok' })) }) })
  const token = (c) => ({ id: c, expo_push_token: `ExponentPushToken[${c}]` })

  it('absent prefs row / absent key = enabled (sends)', async () => {
    global.fetch.mockResolvedValue(ok())
    // c1 has no prefs row at all; c2 has a prefs object without this key.
    const d = db([token('c1'), token('c2')], { prefRows: [{ id: 'c2', push_prefs: { social: false } }] })
    const out = await sendCustomerPush(d, ['c1', 'c2'], { title: 't', body: 'b', data: { type: 'class_reminder' } })
    expect(out.skipped).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('prefs[channel] === false → recipient dropped and counted in skipped', async () => {
    global.fetch.mockResolvedValue(ok())
    const d = db([token('c1')], { prefRows: [{ id: 'c1', push_prefs: { social: false } }, { id: 'c2', push_prefs: {} }] })
    const out = await sendCustomerPush(d, ['c1', 'c2'], { title: 't', body: 'b', data: { type: 'friend_request' } })
    expect(out.skipped).toBe(1)
    // Token query only sees the allowed contact.
    expect(d.queried.tokenContactIds).toEqual(['c2'])
  })

  it('all recipients opted out → nothing sent, no Expo call', async () => {
    const d = db([token('c1')], { prefRows: [{ id: 'c1', push_prefs: { progress: false } }] })
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b', data: { type: 'session_report' } })
    expect(out).toEqual({ sent: 0, invalidated: 0, failed: 0, skipped: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("default channel (unknown/missing type) always sends — prefs aren't even queried", async () => {
    global.fetch.mockResolvedValue(ok())
    const d = db([token('c1')], { prefRows: [{ id: 'c1', push_prefs: { reminders: false, social: false, progress: false } }] })
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.sent).toBe(1)
    expect(out.skipped).toBe(0)
    expect(d.queried.contactIds).toBeNull()
  })

  it('prefs lookup error fails OPEN (sends to all)', async () => {
    global.fetch.mockResolvedValue(ok())
    const d = db([token('c1')], { prefRows: null, prefError: { message: 'db down' } })
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b', data: { type: 'class_reminder' } })
    expect(out.sent).toBe(1)
    expect(out.skipped).toBe(0)
  })
})

describe('sendCustomerPush — Expo failure handling (retry + failed count)', () => {
  const okResponse = { ok: true, json: async () => ({ data: [{ status: 'ok' }] }) }
  const oneToken = () => db([{ id: '1', expo_push_token: 'ExponentPushToken[a]' }])

  it('retries a 429 and succeeds on the second attempt', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce(okResponse)
    const out = await runWithFakeTimers(() => sendCustomerPush(oneToken(), 'c1', { title: 't', body: 'b' }))
    expect(out.sent).toBe(1)
    expect(out.failed).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a fetch exception and a 5xx, then succeeds', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce(okResponse)
    const out = await runWithFakeTimers(() => sendCustomerPush(oneToken(), 'c1', { title: 't', body: 'b' }))
    expect(out.sent).toBe(1)
    expect(out.failed).toBe(0)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 attempts and counts the batch as failed (NOT sent)', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const out = await runWithFakeTimers(() => sendCustomerPush(oneToken(), 'c1', { title: 't', body: 'b' }))
    expect(out.sent).toBe(0) // pre-fix this reported sent=1 on a total failure
    expect(out.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-429 4xx', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' })
    const out = await sendCustomerPush(oneToken(), 'c1', { title: 't', body: 'b' })
    expect(out.sent).toBe(0)
    expect(out.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('counts an unparseable 2xx response as failed (was a silent no-op)', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json') } })
    const out = await runWithFakeTimers(() => sendCustomerPush(oneToken(), 'c1', { title: 't', body: 'b' }))
    expect(out.sent).toBe(0)
    expect(out.failed).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('counts non-DeviceNotRegistered ticket errors as failed without pruning', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'error', details: { error: 'MessageTooBig' } }] }) })
    const d = oneToken()
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.sent).toBe(0)
    expect(out.failed).toBe(1)
    expect(out.invalidated).toBe(0)
    expect(d.deleted.tokens).toBeNull()
  })

  it('reports invalidated=0 when the dead-token prune itself errors', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) })
    const d = db([{ id: '1', expo_push_token: 'ExponentPushToken[dead]' }], { deleteError: { message: 'rls says no' } })
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.invalidated).toBe(0)
  })
})
