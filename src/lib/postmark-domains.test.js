// Tests for the Postmark ACCOUNT-level Domains API wrappers (HOST-EMAIL.2).
// fetch is stubbed — these verify request shape (method/path/headers/body),
// error mapping (Postmark's Message surfaced, the account token NEVER), and
// the pure helpers (label sanitizer + defensive DNS-record mapping).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createDomain,
  getDomain,
  verifyDkim,
  verifyReturnPath,
  sanitizeDomainLabel,
  dnsRecordsFrom,
  domainIsFullyVerified,
} from './postmark-domains.js'

const TOKEN = 'pm-account-test-token'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
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

describe('createDomain', () => {
  it('POSTs /domains with { Name } and the account-token header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 42, Name: 'acme.mail.un1tdublin.com' }))
    const out = await createDomain('acme.mail.un1tdublin.com')
    expect(out).toEqual({ ID: 42, Name: 'acme.mail.un1tdublin.com' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/domains')
    expect(opts.method).toBe('POST')
    expect(opts.headers['X-Postmark-Account-Token']).toBe(TOKEN)
    expect(JSON.parse(opts.body)).toEqual({ Name: 'acme.mail.un1tdublin.com' })
  })

  it('throws with Postmark Message on non-2xx — and never leaks the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ErrorCode: 503, Message: 'This domain already exists on your account.' }, 422))
    let err
    try { await createDomain('acme.mail.un1tdublin.com') } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(err.message).toContain('This domain already exists on your account.')
    expect(err.message).not.toContain(TOKEN)
  })

  it('throws HTTP status when the error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
    await expect(createDomain('x.mail.un1tdublin.com')).rejects.toThrow(/500/)
  })

  it('throws a clear config error (before any fetch) when POSTMARK_ACCOUNT_TOKEN is unset', async () => {
    delete process.env.POSTMARK_ACCOUNT_TOKEN
    await expect(createDomain('x.mail.un1tdublin.com')).rejects.toThrow(/POSTMARK_ACCOUNT_TOKEN/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getDomain / verifyDkim / verifyReturnPath', () => {
  it('getDomain GETs /domains/{id}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 7 }))
    await getDomain(7)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/domains/7')
    expect(opts.method).toBe('GET')
    expect(opts.body).toBeUndefined()
  })

  it('verifyDkim PUTs /domains/{id}/verifyDkim', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 7, DKIMVerified: true }))
    await verifyDkim(7)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/domains/7/verifyDkim')
    expect(opts.method).toBe('PUT')
  })

  it('verifyReturnPath PUTs /domains/{id}/verifyReturnPath', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ID: 7, ReturnPathDomainVerified: false }))
    await verifyReturnPath(7)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/domains/7/verifyReturnPath')
    expect(opts.method).toBe('PUT')
  })
})

describe('sanitizeDomainLabel', () => {
  it('lowercases and collapses non-alphanumeric runs to single dashes', () => {
    expect(sanitizeDomainLabel('Acme Events & Co.')).toBe('acme-events-co')
  })
  it('trims leading/trailing dashes', () => {
    expect(sanitizeDomainLabel('--acme--')).toBe('acme')
  })
  it('returns empty string for degenerate input', () => {
    expect(sanitizeDomainLabel('!!!')).toBe('')
    expect(sanitizeDomainLabel(null)).toBe('')
    expect(sanitizeDomainLabel(undefined)).toBe('')
  })
})

describe('dnsRecordsFrom', () => {
  it('maps pending DKIM fields + Return-Path CNAME', () => {
    const records = dnsRecordsFrom({
      DKIMPendingHost: '20260710._domainkey.acme.mail.un1tdublin.com',
      DKIMPendingTextValue: 'k=rsa; p=MIGf...',
      ReturnPathDomain: 'pm-bounces.acme.mail.un1tdublin.com',
      ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
    })
    expect(records).toEqual([
      { purpose: 'DKIM', type: 'TXT', name: '20260710._domainkey.acme.mail.un1tdublin.com', value: 'k=rsa; p=MIGf...' },
      { purpose: 'Return-Path', type: 'CNAME', name: 'pm-bounces.acme.mail.un1tdublin.com', value: 'pm.mtasv.net' },
    ])
  })

  it('falls back to the active DKIM fields when no pending key exists', () => {
    const records = dnsRecordsFrom({
      DKIMHost: '20260101._domainkey.acme.mail.un1tdublin.com',
      DKIMTextValue: 'k=rsa; p=OLD...',
      ReturnPathDomain: 'pm-bounces.acme.mail.un1tdublin.com',
      ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
    })
    expect(records[0]).toEqual({
      purpose: 'DKIM', type: 'TXT',
      name: '20260101._domainkey.acme.mail.un1tdublin.com',
      value: 'k=rsa; p=OLD...',
    })
  })

  it('omits entries whose name or value is missing (defensive)', () => {
    expect(dnsRecordsFrom({})).toEqual([])
    expect(dnsRecordsFrom(null)).toEqual([])
    expect(dnsRecordsFrom({ DKIMPendingHost: 'x' })).toEqual([]) // no value → omitted
    expect(dnsRecordsFrom({ ReturnPathDomain: 'x' })).toEqual([]) // no CNAME value → omitted
  })
})

describe('domainIsFullyVerified', () => {
  it('requires BOTH DKIM and Return-Path', () => {
    expect(domainIsFullyVerified({ DKIMVerified: true, ReturnPathDomainVerified: true })).toBe(true)
    expect(domainIsFullyVerified({ DKIMVerified: true, ReturnPathDomainVerified: false })).toBe(false)
    expect(domainIsFullyVerified({ DKIMVerified: false, ReturnPathDomainVerified: true })).toBe(false)
    expect(domainIsFullyVerified(null)).toBe(false)
  })
})
