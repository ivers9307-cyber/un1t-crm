// Tests for the contract notification emails' branding header.
//
// The senders call createServerClient() internally and resolve the
// location's branding from company_settings (via getLocationBranding).
// We mock Supabase + Postmark and let the REAL getLocationBranding run
// against the mock db, so these tests exercise the actual table lookup
// and assert the rendered HTML carries the configured logo + name.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark.js', () => ({ sendEmail: vi.fn() }))
vi.mock('./supabase.js', () => ({ createServerClient: vi.fn() }))

import { createServerClient } from './supabase.js'
import { sendEmail } from './postmark.js'
import { sendContractIssuedEmail, sendContractSignedEmails } from './contracts-email.js'

// Table-aware supabase-builder mock. getLocationBranding does
// from('company_settings').select(...).eq(...).limit(1); the legacy
// (buggy) code did from('company_branding')...maybeSingle() — both
// chains are supported so the suite fails on an assertion, not a
// missing mock method. Branding rows only exist for company_settings.
function makeDb(rowsByTable) {
  return {
    from(table) {
      const rows = rowsByTable[table] || []
      const builder = {
        select() { return builder },
        eq() { return builder },
        limit() { return Promise.resolve({ data: rows, error: null }) },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
      }
      return builder
    },
  }
}

const baseArgs = {
  contract: { id: 'ct-1', location_id: 'loc-1', profile_id: 'p-1', signed_at: '2026-05-08T18:50:00Z' },
  recipient: { full_name: 'Sarah Test', email: 'sarah@test.com' },
  issuer: { full_name: 'Boss Person', email: 'boss@test.com' },
  templateName: 'Coach Agreement',
}

beforeEach(() => {
  vi.clearAllMocks()
  sendEmail.mockResolvedValue(undefined)
})

describe('contract email branding header', () => {
  it('renders the configured logo + company name from company_settings', async () => {
    createServerClient.mockReturnValue(makeDb({
      company_settings: [{ company_name: 'Acme Fitness', logo_url: 'https://cdn.example/acme-logo.png', favicon_url: null }],
    }))

    const res = await sendContractIssuedEmail(baseArgs)

    expect(res).toEqual({ ok: true })
    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('https://cdn.example/acme-logo.png') // configured logo rendered
    expect(htmlBody).toContain('alt="Acme Fitness"')                // configured name as alt text
  })

  it('falls back to the UN1T wordmark when no branding row exists', async () => {
    createServerClient.mockReturnValue(makeDb({ company_settings: [] }))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('>UN1T<') // plain wordmark fallback
    expect(htmlBody).not.toContain('<img') // no logo image when none configured
  })

  it('escapes the company name when used as the logo alt text', async () => {
    createServerClient.mockReturnValue(makeDb({
      company_settings: [{ company_name: 'Tom & Jerry "Gym"', logo_url: 'https://cdn.example/x.png', favicon_url: null }],
    }))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('alt="Tom &amp; Jerry &quot;Gym&quot;"')
  })

  it('threads branding into BOTH emails on the signed path', async () => {
    createServerClient.mockReturnValue(makeDb({
      company_settings: [{ company_name: 'Acme Fitness', logo_url: 'https://cdn.example/acme-logo.png', favicon_url: null }],
    }))

    const res = await sendContractSignedEmails(baseArgs)

    expect(res.recipient).toEqual({ ok: true })
    expect(res.issuer).toEqual({ ok: true })
    expect(sendEmail).toHaveBeenCalledTimes(2)
    for (const call of sendEmail.mock.calls) {
      expect(call[0].htmlBody).toContain('https://cdn.example/acme-logo.png')
    }
  })
})
