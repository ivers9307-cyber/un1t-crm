// Tests for the contract notification emails' branding header.
//
// The senders call createServerClient() internally and resolve the
// location's branding from company_settings (via getLocationBranding).
// We mock Supabase + Postmark and let the REAL getLocationBranding run
// against the mock db, so these tests exercise the actual table lookup
// and assert the rendered HTML carries the configured logo + name.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./postmark.js', () => ({ sendEmail: vi.fn() }))
vi.mock('./supabase.js', () => ({ createServerClient: vi.fn() }))

import { createServerClient } from './supabase.js'
import { sendEmail } from './postmark.js'
import { sendContractIssuedEmail, sendContractSignedEmails, sendContractDeclinedEmail } from './contracts-email.js'

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
  contract: { id: 'ct-1', location_id: 'loc-1', organization_id: 'org-1', profile_id: 'p-1', signed_at: '2026-05-08T18:50:00Z' },
  recipient: { full_name: 'Sarah Test', email: 'sarah@test.com' },
  issuer: { full_name: 'Boss Person', email: 'boss@test.com' },
  templateName: 'Coach Agreement',
}

// URLSEAM.1 — every link in these emails is served by THIS deployment, so
// the base comes from getAppUrl(), which THROWS when NEXT_PUBLIC_APP_URL is
// unset (CLAUDE.md: no silent env fallbacks). Configure it the way prod does.
const CRM_HOST = 'https://crm.repset.ie'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', CRM_HOST)
  sendEmail.mockResolvedValue(undefined)
})

afterEach(() => { vi.unstubAllEnvs() })

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

// CONTRACTS-PDF.1 — the signed-contract PDF rides along as an
// attachment on BOTH signed emails when the sign route managed to
// render one. The no-buffer path must stay byte-identical to before.
describe('sendContractSignedEmails — signed PDF attachment', () => {
  beforeEach(() => {
    createServerClient.mockReturnValue(makeDb({ company_settings: [] }))
  })

  it('attaches signed-contract.pdf to BOTH emails when a buffer is passed', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.3 fake pdf bytes')

    const res = await sendContractSignedEmails({ ...baseArgs, pdfBuffer })

    expect(res.recipient).toEqual({ ok: true })
    expect(res.issuer).toEqual({ ok: true })
    expect(res.warning).toBeUndefined()
    expect(sendEmail).toHaveBeenCalledTimes(2)
    for (const call of sendEmail.mock.calls) {
      expect(call[0].attachments).toEqual([{
        Name: 'signed-contract.pdf',
        Content: pdfBuffer.toString('base64'),
        ContentType: 'application/pdf',
      }])
    }
  })

  it('sends with NO attachments key value when no buffer is passed (unchanged behaviour)', async () => {
    await sendContractSignedEmails(baseArgs)
    for (const call of sendEmail.mock.calls) {
      expect(call[0].attachments).toBeUndefined()
    }
  })

  it('skips an oversized PDF and reports a warning instead of dropping the emails', async () => {
    // 9MB raw would exceed Postmark's 10MB message cap once base64'd.
    const pdfBuffer = Buffer.alloc(9 * 1024 * 1024, 0x41)

    const res = await sendContractSignedEmails({ ...baseArgs, pdfBuffer })

    expect(res.recipient).toEqual({ ok: true })
    expect(res.issuer).toEqual({ ok: true })
    expect(res.warning).toMatch(/too large to attach/i)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    for (const call of sendEmail.mock.calls) {
      expect(call[0].attachments).toBeUndefined()
    }
  })

  it('ignores a zero-length buffer', async () => {
    const res = await sendContractSignedEmails({ ...baseArgs, pdfBuffer: Buffer.alloc(0) })
    expect(res.warning).toBeUndefined()
    for (const call of sendEmail.mock.calls) {
      expect(call[0].attachments).toBeUndefined()
    }
  })
})

// HUBS.2d — /admin/contracts moved to /contracts. These two senders build
// an issuer-facing link that stays actionable for months (a notification
// email sitting unread in an inbox), so the producer must point at the
// new home, never the old one.
describe('issuer notification links point at /contracts (HUBS.2d)', () => {
  it('sendContractSignedEmails — issuer notification links to /contracts/<id>, not /admin/contracts', async () => {
    createServerClient.mockReturnValue(makeDb({}))
    await sendContractSignedEmails(baseArgs)
    const issuerCall = sendEmail.mock.calls.find(c => c[0].tag === 'contract-signed-issuer')
    expect(issuerCall[0].htmlBody).toContain(`/contracts/${baseArgs.contract.id}`)
    expect(issuerCall[0].htmlBody).not.toContain('/admin/contracts')
  })

  it('sendContractDeclinedEmail — issuer notification links to /contracts/<id>, not /admin/contracts', async () => {
    createServerClient.mockReturnValue(makeDb({}))
    await sendContractDeclinedEmail(baseArgs)
    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain(`/contracts/${baseArgs.contract.id}`)
    expect(htmlBody).not.toContain('/admin/contracts')
  })
})

// LEGALENT.1 — the footer names the CONTRACTING COMPANY. It used to be
// a literal naming a company formed from the gym brand that appears in
// no register, on an email a member receives alongside a document they
// are about to sign. It now resolves the same way the countersignature
// block does: org_settings.legal_entity_name (mig 425), falling back
// to the resolved brand.
describe('contract email footer names the contracting entity (LEGALENT.1)', () => {
  it('renders the org\'s configured legal entity and trading name', async () => {
    createServerClient.mockReturnValue(makeDb({
      company_settings: [{ company_name: 'UN1T', logo_url: null, favicon_url: null }],
      org_settings: [{ legal_entity_name: 'Champ Fitness Ltd', legal_trading_name: 'UN1T Dublin' }],
    }))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('Champ Fitness Ltd (trading as UN1T Dublin)')
  })

  it('falls back to the BRAND when the org has no legal entity configured', async () => {
    // The load-bearing rule: every business in this estate is its own
    // legal entity, so an unconfigured org must render an
    // under-specified footer, never another company's registered name.
    createServerClient.mockReturnValue(makeDb({
      company_settings: [{ company_name: 'CCF Autos', logo_url: null, favicon_url: null }],
      org_settings: [],
    }))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('CCF Autos ·')
    expect(htmlBody).not.toContain('Champ Fitness')
  })

  it('escapes the entity label in the footer', async () => {
    createServerClient.mockReturnValue(makeDb({
      org_settings: [{ legal_entity_name: 'Tom & Jerry Ltd', legal_trading_name: null }],
    }))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('Tom &amp; Jerry Ltd ·')
  })
})

// URLSEAM.1 — the link base is a SEAM, not a literal. It used to be
// `NEXT_PUBLIC_APP_URL || '<hard-coded host>'`, so on any deploy whose env
// named a different host (a preview, the next domain change) the links
// silently pointed at the old one. getAppUrl() is the only accessor and it
// throws rather than guessing.
describe('link base follows the NEXT_PUBLIC_APP_URL seam (URLSEAM.1)', () => {
  it('builds every link on the configured host, including a preview host', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://un1t-crm-git-x.vercel.app')
    createServerClient.mockReturnValue(makeDb({}))

    await sendContractIssuedEmail(baseArgs)

    const { htmlBody } = sendEmail.mock.calls[0][0]
    expect(htmlBody).toContain('https://un1t-crm-git-x.vercel.app/account/contracts/ct-1')
    expect(htmlBody).toContain('https://un1t-crm-git-x.vercel.app/privacy')
    expect(htmlBody).not.toContain('crm.repset.ie')
    expect(htmlBody).not.toContain('crm.un1tdublin.com')
  })

  it('throws instead of guessing a host when the env is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    createServerClient.mockReturnValue(makeDb({}))

    await expect(sendContractIssuedEmail(baseArgs)).rejects.toThrow(/NEXT_PUBLIC_APP_URL is not set/)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
