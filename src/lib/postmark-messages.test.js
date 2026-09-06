import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listOutboundMessages, getOutboundMessageDetails } from './postmark-messages.js'

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => { process.env.POSTMARK_API_KEY = 't'; vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.POSTMARK_API_KEY })

describe('listOutboundMessages', () => {
  it('GETs /messages/outbound with tag, dates, count, offset and the server token', async () => {
    fetch.mockResolvedValueOnce(json({ TotalCount: 1, Messages: [{ MessageID: 'm1', Metadata: { host_campaign_id: 'hc' } }] }))
    const r = await listOutboundMessages({ tag: 'host-campaign', fromDate: '2026-07-23', toDate: '2026-09-06', count: 500, offset: 0 })
    expect(r).toEqual({ total: 1, messages: [{ MessageID: 'm1', Metadata: { host_campaign_id: 'hc' } }], error: null })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/messages/outbound?count=500&offset=0&tag=host-campaign&fromdate=2026-07-23&todate=2026-09-06')
    expect(init.headers['X-Postmark-Server-Token']).toBe('t')
    expect(init.method).toBe('GET')
  })
  it('omits absent filters', async () => {
    fetch.mockResolvedValueOnce(json({ TotalCount: 0, Messages: [] }))
    await listOutboundMessages({ tag: 'x' })
    expect(fetch.mock.calls[0][0]).toBe('https://api.postmarkapp.com/messages/outbound?count=500&offset=0&tag=x')
  })
  it('a non-2xx is returned as error, never thrown', async () => {
    fetch.mockResolvedValueOnce(json({ Message: 'nope' }, false, 401))
    expect(await listOutboundMessages({ tag: 'x' })).toEqual({ total: 0, messages: [], error: 'nope' })
  })
  it('a thrown fetch is returned as error', async () => {
    fetch.mockRejectedValueOnce(new Error('net'))
    expect(await listOutboundMessages({ tag: 'x' })).toEqual({ total: 0, messages: [], error: 'net' })
  })
  it('no token → error, no fetch', async () => {
    delete process.env.POSTMARK_API_KEY
    expect((await listOutboundMessages({ tag: 'x' })).error).toMatch(/token/i)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('an ok response whose body cannot be parsed is returned as error, never thrown', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    expect(await listOutboundMessages({ tag: 'x' })).toEqual({ total: 0, messages: [], error: 'Postmark returned an unreadable response' })
  })
})
describe('getOutboundMessageDetails', () => {
  it('GETs /messages/outbound/{id}/details and returns the payload', async () => {
    fetch.mockResolvedValueOnce(json({ MessageID: 'm1', MessageEvents: [{ Type: 'Delivered', ReceivedAt: 'd' }] }))
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: { MessageID: 'm1', MessageEvents: [{ Type: 'Delivered', ReceivedAt: 'd' }] }, error: null })
    expect(fetch.mock.calls[0][0]).toBe('https://api.postmarkapp.com/messages/outbound/m1/details')
  })
  it('URL-encodes the id', async () => {
    fetch.mockResolvedValueOnce(json({ MessageID: 'a b' }))
    await getOutboundMessageDetails('a b')
    expect(fetch.mock.calls[0][0]).toBe('https://api.postmarkapp.com/messages/outbound/a%20b/details')
  })
  it('a non-2xx is returned as error', async () => {
    fetch.mockResolvedValueOnce(json({ Message: 'gone' }, false, 404))
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: null, error: 'gone' })
  })
  it('a thrown fetch is returned as error', async () => {
    fetch.mockRejectedValueOnce(new Error('net'))
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: null, error: 'net' })
  })
  it('an ok response whose body cannot be parsed is returned as error, never thrown', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: null, error: 'Postmark returned an unreadable response' })
  })
})
