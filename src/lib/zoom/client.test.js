import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { zoomConfigured, zoomFetch, __resetTokenCache } from './client'

const OK_TOKEN = { access_token: 'tok-abc', expires_in: 3600 }

function mockFetchSequence(responses) {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce(r)
  global.fetch = fn
  return fn
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  }
}

describe('zoom client', () => {
  // `global.fetch = fn` below is a plain property reassignment, not a
  // vi.spyOn() spy — vi.restoreAllMocks() does not undo it. Save/restore it
  // ourselves.
  let originalFetch
  beforeEach(() => {
    originalFetch = global.fetch
    __resetTokenCache()
    process.env.ZOOM_ACCOUNT_ID = 'acct'
    process.env.ZOOM_CLIENT_ID = 'cid'
    process.env.ZOOM_CLIENT_SECRET = 'secret'
    process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-un1t'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('reports unconfigured when any secret is missing', () => {
    delete process.env.ZOOM_CLIENT_SECRET
    expect(zoomConfigured()).toBe(false)
    process.env.ZOOM_CLIENT_SECRET = 'secret'
    expect(zoomConfigured()).toBe(true)
  })

  // ZOOMSYNC.2 — the tenant boundary gates the sync exactly like a credential.
  // Without it there is no safe read of `contacts`, so it must ship dark
  // rather than run unscoped.
  it('reports unconfigured when the organisation boundary is missing', () => {
    delete process.env.ZOOM_SYNC_ORGANIZATION_ID
    expect(zoomConfigured()).toBe(false)
    process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-un1t'
    expect(zoomConfigured()).toBe(true)
  })

  it('fetches a token then calls the API with it', async () => {
    const fetchFn = mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ external_contacts: [] }),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(true)
    expect(res.body).toEqual({ external_contacts: [] })
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-abc')
  })

  it('reuses the cached token across calls', async () => {
    const fetchFn = mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ a: 1 }),
      jsonResponse({ b: 2 }),
    ])
    await zoomFetch('/one')
    await zoomFetch('/two')
    // 1 token call + 2 API calls, not 2 token calls.
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('retries once on 429, honouring Retry-After', async () => {
    mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ error: 'rate' }, 429, { 'retry-after': '0' }),
      jsonResponse({ ok: true }),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(true)
  })

  it('surfaces a non-retryable error without throwing', async () => {
    mockFetchSequence([
      jsonResponse(OK_TOKEN),
      jsonResponse({ message: 'Bad Request' }, 400),
    ])
    const res = await zoomFetch('/phone/external_contacts')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})
