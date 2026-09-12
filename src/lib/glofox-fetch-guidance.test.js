// GLOFOX-SPEC-2026-09 — two pieces of guidance from the September 2026 spec:
//
//  1. `GET /2.0/events` is deprecated in favour of the branch-scoped
//     `GET /2.0/branches/{branchId}/events` ("same query parameters"). The
//     class list is the one hot path still on the old spelling.
//  2. "Older endpoints sometimes return a 200 with `success: false`. That
//     indicates a bad request." Every caller checks that on its own today;
//     the wrapper now at least says so out loud, so the ones that miss it
//     show up in the logs instead of as a silent no-op.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }

const res = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => { if (!json) throw new SyntaxError('not json'); return body },
  clone() { return res(status, body, { json }) },
})

describe('fetchUpcomingEvents', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads the branch-scoped events path with the same start/end/limit query', async () => {
    const { fetchUpcomingEvents } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [{ _id: 'e1' }] }))
    const r = await fetchUpcomingEvents(creds, { start: 100, end: 200, limit: 5 })
    const url = global.fetch.mock.calls[0][0]
    expect(url).toContain('/2.0/branches/br-1/events?')
    expect(url).not.toContain('/2.0/events?')
    expect(url).toContain('start=100')
    expect(url).toContain('end=200')
    expect(url).toContain('limit=5')
    expect(r.events).toEqual([{ _id: 'e1' }])
  })
})

describe('glofoxFetch — 200 with success:false is named in the log', () => {
  let warn
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('warns once, naming the path and message_code, and leaves the body readable', async () => {
    const { glofoxFetch } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { success: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' }))
    const r = await glofoxFetch(creds, '/2.0/bookings', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' })
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain('success:false')
    expect(line).toContain('/2.0/bookings')
    expect(line).toContain('YOU_HAVE_NO_CREDITS_LEFT')
  })

  it('stays silent on a real success and on a non-JSON body', async () => {
    const { glofoxFetch } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { success: true, data: [] }))
    await glofoxFetch(creds, '/2.0/members')
    global.fetch.mockResolvedValueOnce(res(200, null, { json: false }))
    await glofoxFetch(creds, '/TermsConditions/view')
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn on a plain error status — that is the caller\'s HTTP check', async () => {
    const { glofoxFetch } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(400, { success: false, message_code: 'INVALID_EMAIL' }))
    const r = await glofoxFetch(creds, '/2.0/register', { method: 'POST', body: '{}' })
    expect(r.status).toBe(400)
    expect(warn).not.toHaveBeenCalled()
  })
})
