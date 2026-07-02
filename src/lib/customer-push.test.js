import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendCustomerPush } from './customer-push.js'

function db(rows, { deleteError = null } = {}) {
  const deleted = { tokens: null }
  return {
    deleted,
    from() {
      return {
        select() { return { in: () => Promise.resolve({ data: rows }) } },
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
    expect(await sendCustomerPush(db([]), 'c1', { title: 't', body: 'b' })).toEqual({ sent: 0, invalidated: 0, failed: 0 })
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
