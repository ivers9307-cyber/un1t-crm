// Tests for the contractor invoice approval/decline emails.
//
// The branded header (logo + company name) must come from
// company_settings via getLocationBranding — NOT from the locations
// table, which has no logo_url/company_name columns (mig 004 vs the
// company_settings table in mig 013). These tests lock that in:
// branding is sourced from company_settings, and a missing branding
// row falls back to the neutral "UN1T" wordmark.
//
// createServerClient + the Postmark fetch are mocked so we can assert
// on the composed HtmlBody without standing up Supabase or Postmark.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { sendInvoiceApprovedEmail, sendInvoiceDeclinedEmail } from './contractor-invoice-email.js'
import { createServerClient } from '@/lib/supabase'

const INVOICE = {
  id: 'inv-1',
  period_start: '2026-06-01',
  period_end: '2026-06-30',
  invoice_amount: 1234.5,
  status: 'approved',
  decline_reason: 'Please itemise the extra sessions.',
  approved_at: '2026-06-26T10:00:00Z',
  reviewed_by: 'rev-1',
  location_id: 'loc-1',
  contractor: { id: 'con-1', full_name: 'Pat Coach', email: 'pat@example.com' },
  reviewer: { full_name: 'Mia Manager' },
}

// Mock createServerClient: contractor_invoices.select().eq().single()
// resolves to `invoice`; company_settings.select().eq().limit() resolves
// to `companySettings` (the array shape getLocationBranding expects).
function mockClient({ invoice = INVOICE, companySettings = [] } = {}) {
  return {
    from(table) {
      if (table === 'contractor_invoices') {
        return {
          select() { return this },
          eq() { return this },
          single() { return Promise.resolve({ data: invoice, error: null }) },
        }
      }
      if (table === 'company_settings') {
        return {
          select() { return this },
          eq() { return this },
          limit() { return Promise.resolve({ data: companySettings, error: null }) },
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

// Capture the Postmark request body from the mocked fetch.
function stubPostmark() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ MessageID: 'mid-1' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentHtml(fetchMock) {
  return JSON.parse(fetchMock.mock.calls[0][1].body).HtmlBody
}

// URLSEAM.1 — /schedule/invoices is served by THIS deployment, so the link
// base comes from getAppUrl(), which THROWS when NEXT_PUBLIC_APP_URL is unset
// (CLAUDE.md: no silent env fallbacks). Configure it the way prod does.
beforeEach(() => {
  vi.stubEnv('POSTMARK_API_KEY', 'test-token')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('sendInvoiceApprovedEmail — branding from company_settings', () => {
  it('renders the company_settings logo in the email header', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      mockClient({
        companySettings: [{ company_name: 'UN1T Stillorgan', logo_url: 'https://cdn.example.com/logo.png', favicon_url: null }],
      })
    )
    const fetchMock = stubPostmark()

    const res = await sendInvoiceApprovedEmail('inv-1')

    expect(res.messageId).toBe('mid-1')
    const html = sentHtml(fetchMock)
    expect(html).toContain('src="https://cdn.example.com/logo.png"')
    // alt text uses the operator-configured company name
    expect(html).toContain('UN1T Stillorgan')
  })

  it('falls back to the UN1T wordmark when no branding row exists (no logo img)', async () => {
    vi.mocked(createServerClient).mockReturnValue(mockClient({ companySettings: [] }))
    const fetchMock = stubPostmark()

    await sendInvoiceApprovedEmail('inv-1')

    const html = sentHtml(fetchMock)
    expect(html).not.toContain('<img')
    expect(html).toContain('UN1T')
  })
})

describe('sendInvoiceDeclinedEmail — branding from company_settings', () => {
  it('uses the configured company name when one is set but no logo', async () => {
    vi.mocked(createServerClient).mockReturnValue(
      mockClient({
        companySettings: [{ company_name: 'CCF Autos', logo_url: null, favicon_url: null }],
      })
    )
    const fetchMock = stubPostmark()

    await sendInvoiceDeclinedEmail('inv-1')

    const html = sentHtml(fetchMock)
    expect(html).not.toContain('<img')
    expect(html).toContain('CCF Autos')
    // the decline reason still renders alongside the branding
    expect(html).toContain('Please itemise the extra sessions.')
  })
})

// Prod regression 2026-08-02: Vercel sets POSTMARK_SERVER_TOKEN (the
// var the main postmark.js lib falls back to) but not POSTMARK_API_KEY.
// This lib read POSTMARK_API_KEY only, so approving an invoice recorded
// the approval but the contractor email threw "POSTMARK_API_KEY is not
// configured." Token resolution now goes through resolvePostmarkToken.
describe('Postmark token fallback', () => {
  it('sends with POSTMARK_SERVER_TOKEN when POSTMARK_API_KEY is unset', async () => {
    vi.stubEnv('POSTMARK_API_KEY', '')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'server-token-only')
    vi.mocked(createServerClient).mockReturnValue(mockClient())
    const fetchMock = stubPostmark()

    const res = await sendInvoiceApprovedEmail('inv-1')

    expect(res.messageId).toBe('mid-1')
    expect(fetchMock.mock.calls[0][1].headers['X-Postmark-Server-Token']).toBe('server-token-only')
  })
})

// URLSEAM.1 — the link base is a SEAM, not a literal. It used to be
// `NEXT_PUBLIC_APP_URL || '<hard-coded host>'`, so a deploy whose env named
// a different host still linked to the old one. getAppUrl() is the only
// accessor and it throws rather than guessing.
describe('link base follows the NEXT_PUBLIC_APP_URL seam (URLSEAM.1)', () => {
  it('builds the submission-history link on the configured host, preview included', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://un1t-crm-git-x.vercel.app')
    vi.mocked(createServerClient).mockReturnValue(mockClient({ companySettings: [] }))
    const fetchMock = stubPostmark()

    await sendInvoiceApprovedEmail('inv-1')

    const html = sentHtml(fetchMock)
    expect(html).toContain('https://un1t-crm-git-x.vercel.app/schedule/invoices')
    expect(html).not.toContain('crm.repset.ie')
    expect(html).not.toContain('crm.un1tdublin.com')
  })

  it('throws instead of guessing a host when the env is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.mocked(createServerClient).mockReturnValue(mockClient({ companySettings: [] }))
    const fetchMock = stubPostmark()

    await expect(sendInvoiceApprovedEmail('inv-1')).rejects.toThrow(/NEXT_PUBLIC_APP_URL is not set/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
