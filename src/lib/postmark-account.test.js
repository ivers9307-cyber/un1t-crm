// INTEG-B3 — tests for the Postmark ACCOUNT API client (server-per-tenant).
// fetch is stubbed: these verify request shape (method/path/headers/body),
// response shaping (server token extraction, DKIM/Return-Path mapping),
// error mapping (Postmark's Message surfaced, the account token NEVER), and
// the config/sanitizer helpers. NO live Postmark call is ever made.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isPostmarkAccountConfigured,
  createTenantServer,
  createTenantDomain,
  getTenantDomain,
  verifyTenantDomainDkim,
  verifyTenantReturnPath,
  shapeServerResponse,
  shapeDomainResponse,
  domainIsFullyVerified,
  sanitizeSendingDomain,
  ensureTenantServerStreams,
  ensureTenantServerWebhooks,
  WEBHOOK_TRIGGERS,
  WEBHOOK_STREAMS,
} from './postmark-account.js'

const TOKEN = 'pm-account-test-token'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

let fetchMock

beforeEach(() => {
  process.env.POSTMARK_ACCOUNT_TOKEN = TOKEN
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  delete process.env.POSTMARK_ACCOUNT_TOKEN
  vi.unstubAllGlobals()
})

describe('isPostmarkAccountConfigured', () => {
  it('reflects the presence of POSTMARK_ACCOUNT_TOKEN', () => {
    expect(isPostmarkAccountConfigured()).toBe(true)
    delete process.env.POSTMARK_ACCOUNT_TOKEN
    expect(isPostmarkAccountConfigured()).toBe(false)
  })
})

describe('shapeServerResponse (pure)', () => {
  it('pulls id + the FIRST api token (the server token)', () => {
    expect(shapeServerResponse({ ID: 7, ApiTokens: ['srv-tok-1', 'srv-tok-2'] }))
      .toEqual({ id: 7, serverToken: 'srv-tok-1' })
  })
  it('is null-safe', () => {
    expect(shapeServerResponse(null)).toEqual({ id: null, serverToken: null })
    expect(shapeServerResponse({ ID: 7 })).toEqual({ id: 7, serverToken: null })
  })
})

describe('shapeDomainResponse (pure)', () => {
  it('prefers the pending DKIM pair, falls back to the active pair', () => {
    expect(shapeDomainResponse({
      ID: 9,
      DKIMPendingHost: 'pending._domainkey.x', DKIMPendingTextValue: 'k=rsa;pend',
      ReturnPathDomain: 'pm-bounces.x', ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
    })).toEqual({
      id: 9,
      dkimPendingHost: 'pending._domainkey.x', dkimPendingValue: 'k=rsa;pend', dkimVerified: false,
      returnPathDomain: 'pm-bounces.x', returnPathCnameValue: 'pm.mtasv.net', returnPathVerified: false,
    })
    const active = shapeDomainResponse({ DKIMHost: 'active._domainkey.x', DKIMTextValue: 'k=rsa;active', DKIMVerified: true })
    expect(active.dkimPendingHost).toBe('active._domainkey.x')
    expect(active.dkimVerified).toBe(true)
  })
})

describe('domainIsFullyVerified (pure)', () => {
  it('requires BOTH dkim and return-path', () => {
    expect(domainIsFullyVerified({ dkimVerified: true, returnPathVerified: true })).toBe(true)
    expect(domainIsFullyVerified({ dkimVerified: true, returnPathVerified: false })).toBe(false)
    expect(domainIsFullyVerified(null)).toBe(false)
  })
})

describe('sanitizeSendingDomain (pure)', () => {
  it('strips scheme/port/path, lowercases, trims edges', () => {
    expect(sanitizeSendingDomain('  https://Mail.GymX.com:443/path ')).toBe('mail.gymx.com')
    expect(sanitizeSendingDomain('mail.gymx.com')).toBe('mail.gymx.com')
    expect(sanitizeSendingDomain('-.mail.gymx.com.-')).toBe('mail.gymx.com')
    expect(sanitizeSendingDomain(null)).toBe('')
  })
})

describe('createTenantServer', () => {
  it('POSTs /servers with the account-token header and returns id + first token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 101, ApiTokens: ['srv-secret-1'] }))
    const out = await createTenantServer('GymX')
    expect(out).toEqual({ id: 101, serverToken: 'srv-secret-1' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/servers')
    expect(opts.method).toBe('POST')
    expect(opts.headers['X-Postmark-Account-Token']).toBe(TOKEN)
    expect(JSON.parse(opts.body).Name).toContain('GymX')
  })

  it('throws (never leaking the token) when the account token is unset', async () => {
    delete process.env.POSTMARK_ACCOUNT_TOKEN
    let err
    try { await createTenantServer('GymX') } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(err.message).not.toContain(TOKEN)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createTenantDomain / getTenantDomain / verify*', () => {
  it('createTenantDomain POSTs /domains with { Name } and shapes the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 55, DKIMPendingHost: 'h', DKIMPendingTextValue: 'v' }))
    const out = await createTenantDomain('mail.gymx.com')
    expect(out.id).toBe(55)
    expect(out.dkimPendingHost).toBe('h')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/domains')
    expect(JSON.parse(opts.body)).toEqual({ Name: 'mail.gymx.com' })
  })

  it('getTenantDomain GETs /domains/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 55, DKIMVerified: true, ReturnPathDomainVerified: true }))
    const out = await getTenantDomain(55)
    expect(out).toMatchObject({ id: 55, dkimVerified: true, returnPathVerified: true })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.postmarkapp.com/domains/55')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  it('verifyTenantDomainDkim PUTs the verifyDkim endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 55 }))
    await verifyTenantDomainDkim(55)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.postmarkapp.com/domains/55/verifyDkim')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
  })

  it('verifyTenantReturnPath PUTs the verifyReturnPath endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 55 }))
    await verifyTenantReturnPath(55)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.postmarkapp.com/domains/55/verifyReturnPath')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
  })

  it('surfaces Postmark Message on non-2xx and never leaks the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ErrorCode: 422, Message: 'Domain already exists.' }, 422))
    let err
    try { await createTenantDomain('mail.gymx.com') } catch (e) { err = e }
    expect(err.message).toContain('Domain already exists.')
    expect(err.message).not.toContain(TOKEN)
  })
})

// ─────────────────────────────────────────────────────────────
// W1.E3 — a tenant server is born with its streams + webhooks
// ─────────────────────────────────────────────────────────────

// A tiny router on top of the file's vi.fn() fetch stub: `get(path, body)`
// answers a GET by path (query string ignored), every POST records its parsed
// body under its path and answers 200. The plan's fetchMock.get/posted/postedAll
// DSL, implemented locally so no live Postmark call can ever be made.
function routeFetch() {
  const gets = new Map()
  const posts = []
  fetchMock.mockImplementation(async (url, opts = {}) => {
    const path = new URL(url).pathname
    const method = (opts.method || 'GET').toUpperCase()
    if (method === 'GET') {
      if (!gets.has(path)) return jsonResponse({ Message: `no stub for GET ${path}` }, 500)
      return jsonResponse(gets.get(path))
    }
    posts.push({ path, body: JSON.parse(opts.body), headers: opts.headers })
    return jsonResponse({ ID: 1 })
  })
  return {
    get: (path, body) => gets.set(path, body),
    posted: (path) => posts.find((p) => p.path === path)?.body,
    postedAll: (path) => posts.filter((p) => p.path === path).map((p) => p.body),
  }
}

describe('W1.E3 tenant server streams + webhooks', () => {
  const WEBHOOK_URL = 'https://crm.repset.ie/api/webhooks/postmark'

  beforeEach(() => {
    vi.stubEnv('POSTMARK_WEBHOOK_TOKEN', 'wh-secret')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('creates the broadcast stream when the server has only outbound/inbound', async () => {
    const r = routeFetch()
    r.get('/message-streams', { MessageStreams: [{ ID: 'outbound' }, { ID: 'inbound' }] })
    const out = await ensureTenantServerStreams('srv-tok')
    expect(out).toEqual({ created: true })
    expect(r.posted('/message-streams')).toEqual({
      ID: 'broadcast', Name: 'Broadcasts', MessageStreamType: 'Broadcasts',
      SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' },
    })
  })

  it('is idempotent: an existing broadcast stream is not created again', async () => {
    const r = routeFetch()
    r.get('/message-streams', { MessageStreams: [{ ID: 'outbound' }, { ID: 'inbound' }, { ID: 'broadcast' }] })
    expect(await ensureTenantServerStreams('srv-tok')).toEqual({ created: false })
    expect(r.postedAll('/message-streams')).toHaveLength(0)
  })

  it('registers one six-trigger webhook per stream, with the X-Webhook-Token header, skipping ones that exist', async () => {
    const r = routeFetch()
    r.get('/webhooks', { Webhooks: [{ Url: WEBHOOK_URL, MessageStream: 'outbound' }] })
    const out = await ensureTenantServerWebhooks('srv-tok')
    expect(out).toEqual({ created: ['broadcast'] })
    const posted = r.postedAll('/webhooks')
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      Url: WEBHOOK_URL, MessageStream: 'broadcast',
      HttpHeaders: [{ Name: 'X-Webhook-Token', Value: 'wh-secret' }],
      Triggers: {
        Open: { Enabled: true, PostFirstOpenOnly: false }, Click: { Enabled: true }, Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false },
        SubscriptionChange: { Enabled: true },
      },
    })
    // The exported constants ARE what goes on the wire (the global CRM.UN1T
    // server's trigger set and the two streams the app sends on).
    expect(posted[0].Triggers).toEqual(WEBHOOK_TRIGGERS)
    expect(WEBHOOK_STREAMS).toEqual(['outbound', 'broadcast'])
  })

  it('registers both streams on a bare server; a hook on a DIFFERENT url does not count', async () => {
    const r = routeFetch()
    r.get('/webhooks', { Webhooks: [{ Url: 'https://elsewhere.example/hook', MessageStream: 'outbound' }] })
    expect(await ensureTenantServerWebhooks('srv-tok')).toEqual({ created: ['outbound', 'broadcast'] })
    expect(r.postedAll('/webhooks').map((w) => w.MessageStream)).toEqual([...WEBHOOK_STREAMS])
  })

  it('refuses to register a webhook without POSTMARK_WEBHOOK_TOKEN (the receiver 403s an unsigned hook), in words an org admin may read', async () => {
    vi.stubEnv('POSTMARK_WEBHOOK_TOKEN', '')
    const r = routeFetch()
    r.get('/webhooks', { Webhooks: [] })
    const err = await ensureTenantServerWebhooks('srv-tok').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Webhook signing token is not configured on this deployment.')
    // The message lands in last_error (rendered to the org admin): no env name.
    expect(err.message).not.toMatch(/POSTMARK_/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('both calls use the SERVER token header, never the account token', async () => {
    const r = routeFetch()
    r.get('/message-streams', { MessageStreams: [] })
    r.get('/webhooks', { Webhooks: [] })
    await ensureTenantServerStreams('srv-tok')
    await ensureTenantServerWebhooks('srv-tok')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const [, opts] of fetchMock.mock.calls) {
      expect(opts.headers['X-Postmark-Server-Token']).toBe('srv-tok')
      expect(opts.headers['X-Postmark-Account-Token']).toBeUndefined()
    }
  })

  it('surfaces a failed create as an error that never carries the server token', async () => {
    fetchMock.mockImplementation(async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'GET') return jsonResponse({ MessageStreams: [] })
      return jsonResponse({ ErrorCode: 1221, Message: 'Stream limit reached.' }, 422)
    })
    const err = await ensureTenantServerStreams('srv-tok').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Stream limit reached.')
    expect(err.message).not.toContain('srv-tok')
  })
})
