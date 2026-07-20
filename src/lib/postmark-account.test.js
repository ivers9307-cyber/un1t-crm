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
