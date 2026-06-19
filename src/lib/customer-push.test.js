import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendCustomerPush } from './customer-push.js'

function db(rows) {
  const deleted = { tokens: null }
  return {
    deleted,
    from() {
      return {
        select() { return { in: () => Promise.resolve({ data: rows }) } },
        delete() { return { in: (_c, toks) => { deleted.tokens = toks; return Promise.resolve({ error: null }) } } },
      }
    },
  }
}
beforeEach(() => { global.fetch = vi.fn() })

describe('sendCustomerPush', () => {
  it('no tokens → sends nothing', async () => {
    expect(await sendCustomerPush(db([]), 'c1', { title: 't', body: 'b' })).toEqual({ sent: 0, invalidated: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('sends to each token', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ data: [{ status: 'ok' }] }) })
    const out = await sendCustomerPush(db([{ id: '1', expo_push_token: 'ExponentPushToken[a]' }]), 'c1', { title: 't', body: 'b', data: { type: 'session_report', session_id: 's1' } })
    expect(out.sent).toBe(1)
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sent[0]).toMatchObject({ to: 'ExponentPushToken[a]', title: 't', data: { type: 'session_report' } })
  })
  it('prunes DeviceNotRegistered', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) })
    const d = db([{ id: '1', expo_push_token: 'ExponentPushToken[dead]' }])
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.invalidated).toBe(1)
    expect(d.deleted.tokens).toEqual(['ExponentPushToken[dead]'])
  })
})
