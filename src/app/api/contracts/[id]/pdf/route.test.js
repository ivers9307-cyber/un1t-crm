// Route-level tests for GET /api/contracts/[id]/pdf.
//
// SECURITY GUARD, same class as the [id] GET tests next door. The route
// runs as service role (RLS bypassed) AND it hands back a signed URL to
// a private-bucket object, so a gate slip here would leak somebody's
// employment contract as a downloadable file to any authenticated
// caller. These tests pin: recipient / master / org-owner get the
// redirect, everyone else gets a 404 (not 403 — ids stay
// non-enumerable), an UNSIGNED contract with no stored PDF is also a 404,
// and (CONTRACTS-PDF.2) a SIGNED one with no PDF is a JSON 409
// `pdf_missing` that says it can be generated.
//
// The POST (CONTRACTS-PDF.2) is the backfill: master / org admin only (404
// otherwise, same posture), 409 unless signed, idempotent on a stored path,
// and it renders through the shared helper (stubbed here; its own tests
// are src/lib/contract-pdf-store.test.js).
//
// We use the REAL org-admin gate — only getCurrentUser, the Supabase
// client, the store helper, the zone and the audit log are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contract-pdf-store', () => ({
  renderAndStoreSignedContractPdf: vi.fn(async ({ contract }) => ({
    pdfBuffer: Buffer.from('%PDF-fake'), pdfPath: `${contract.id}/signed.pdf`, error: null,
  })),
}))
vi.mock('@/lib/display-zone', () => ({ displayZoneFor: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { renderAndStoreSignedContractPdf } from '@/lib/contract-pdf-store'
import { logAuditEvent } from '@/lib/audit'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const SIGNED_URL = 'https://storage.example.com/object/sign/contracts/c1/signed.pdf?token=abc'
const FAKE_REQUEST = new Request('https://example.com/api/contracts/c1/pdf')

// GET reads:  from('contracts').select(...).eq('id', x).maybeSingle()
// then:       storage.from('contracts').createSignedUrl(path, 60)
function mockDb({ contract, contractError = null, signResult } = {}) {
  const createSignedUrl = vi.fn(() =>
    Promise.resolve(signResult || { data: { signedUrl: SIGNED_URL }, error: null })
  )
  const maybeSingle = vi.fn(() =>
    Promise.resolve(
      contractError ? { data: null, error: contractError } : { data: contract, error: null }
    )
  )
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))
  const db = {
    from: vi.fn(() => ({ select })),
    storage: { from: vi.fn(() => ({ createSignedUrl })) },
  }
  return { db, createSignedUrl }
}

function contractFixture(overrides = {}) {
  return {
    id: 'c1',
    profile_id: 'recipient-1',
    organization_id: ORG_A,
    status: 'signed',
    signed_pdf_path: 'c1/signed.pdf',
    ...overrides,
  }
}

const masterUser = { id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [] }
const recipientUser = {
  id: 'recipient-1',
  isMaster: false,
  role: 'staff',
  rolesByLocation: { [LOC_B1]: 'staff' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}
const ownerOfAUser = {
  id: 'owner-a',
  isMaster: false,
  role: 'owner',
  orgAdminOrgIds: [ORG_A], // C18 ORGROLE.1: contracts are for org admins
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}
const outsiderUser = {
  id: 'staff-b',
  isMaster: false,
  role: 'staff',
  rolesByLocation: { [LOC_B1]: 'staff' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}
const ownerOfBUser = {
  id: 'owner-b',
  isMaster: false,
  role: 'owner',
  orgAdminOrgIds: [ORG_B], // C18 ORGROLE.1: contracts are for org admins
  rolesByLocation: { [LOC_B1]: 'owner' },
  locations: [{ id: LOC_B1, organization_id: ORG_B }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/contracts/[id]/pdf — envelope', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/contracts/[id]/pdf — authorization gate', () => {
  it('returns 404 (not 403) for a foreign-org staff caller, and never signs a URL', async () => {
    getCurrentUser.mockResolvedValue(outsiderUser)
    const { db, createSignedUrl } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(res.headers.get('location')).toBeNull()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns 404 for an owner of a DIFFERENT org', async () => {
    getCurrentUser.mockResolvedValue(ownerOfBUser)
    const { db, createSignedUrl } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('returns 404 for a studio owner of the contract org with no org_admin grant (C18 ORGROLE.1)', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerOfAUser, orgAdminOrgIds: [] })
    const { db, createSignedUrl } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('redirects the recipient to a short-lived signed URL', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, createSignedUrl } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(SIGNED_URL)
    expect(createSignedUrl).toHaveBeenCalledWith('c1/signed.pdf', 60)
  })

  it('redirects an owner of the contract org', async () => {
    getCurrentUser.mockResolvedValue(ownerOfAUser)
    const { db, createSignedUrl } = mockDb({ contract: contractFixture() })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(SIGNED_URL)
    expect(createSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('redirects a master', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: contractFixture() }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(302)
  })

  it('404s a recipient reading their own DRAFT (mirrors the [id] GET model)', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, createSignedUrl } = mockDb({
      contract: contractFixture({ status: 'draft', signed_pdf_path: null }),
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })
})

describe('GET /api/contracts/[id]/pdf — no PDF stored', () => {
  it('404s an UNSIGNED contract with no PDF even for an authorized caller (nothing to generate)', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, createSignedUrl } = mockDb({
      contract: contractFixture({ status: 'issued', signed_pdf_path: null }),
    })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  // CONTRACTS-PDF.2 — four of the five signed contracts in prod predate the
  // stored PDF; 'Not found' told nobody why the download failed.
  it('409 pdf_missing for a SIGNED contract with no PDF, for the recipient (canGenerate false)', async () => {
    getCurrentUser.mockResolvedValue(recipientUser)
    const { db, createSignedUrl } = mockDb({
      contract: contractFixture({ status: 'signed', signed_pdf_path: null }),
    })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.success).toBe(false)
    expect(body.code).toBe('pdf_missing')
    expect(body.error).toMatch(/can be generated/)
    expect(body.canGenerate).toBe(false)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('409 pdf_missing with canGenerate true for a master and for an org admin of the contract org', async () => {
    for (const u of [masterUser, ownerOfAUser]) {
      getCurrentUser.mockResolvedValue(u)
      createServerClient.mockReturnValue(mockDb({
        contract: contractFixture({ status: 'signed', signed_pdf_path: null }),
      }).db)
      const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
      const body = await res.json()
      expect(res.status).toBe(409)
      expect(body.code).toBe('pdf_missing')
      expect(body.canGenerate).toBe(true)
    }
  })

  it('a signed-but-missing PDF is STILL 404 for an outsider (the gate runs first)', async () => {
    getCurrentUser.mockResolvedValue(outsiderUser)
    createServerClient.mockReturnValue(mockDb({
      contract: contractFixture({ status: 'signed', signed_pdf_path: null }),
    }).db)
    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.code).toBeUndefined()
  })
})

describe('GET /api/contracts/[id]/pdf — storage failure', () => {
  it('500s (never a public URL) when the signed-URL mint fails', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({
      contract: contractFixture(),
      signResult: { data: null, error: { message: 'Object not found' } },
    }).db)

    const res = await GET(FAKE_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(res.headers.get('location')).toBeNull()
  })
})

// ─── POST (CONTRACTS-PDF.2 backfill) ─────────────────────────────

const POST_REQUEST = new Request('https://example.com/api/contracts/c1/pdf', { method: 'POST' })

// POST reads: from('contracts').select(...).eq('id', x).maybeSingle(); the
// render/upload/path-write live in the stubbed helper.
function signedNoPdf(overrides = {}) {
  return contractFixture({
    status: 'signed',
    signed_pdf_path: null,
    location_id: LOC_A1,
    body_rendered: '# Contract',
    issuer_signature: 'Richard Ivers',
    issued_at: '2026-06-01T09:00:00.000Z',
    signature_value: 'Mark Doyle',
    signed_at: '2026-06-02T10:00:00.000Z',
    signed_ip: '192.0.2.10',
    variables_data: { employer_name: 'Champ fitness LTD' },
    profile: { full_name: 'Mark Doyle' },
    template: { name: 'Coach Contract' },
    ...overrides,
  })
}

describe('POST /api/contracts/[id]/pdf — envelope and gate', () => {
  it('401 with no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('404 when the contract does not exist', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: null }).db)
    const res = await POST(POST_REQUEST, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
    expect(renderAndStoreSignedContractPdf).not.toHaveBeenCalled()
  })

  it.each([
    ['the recipient', recipientUser],
    ['a foreign-org staff caller', outsiderUser],
    ['an org admin of ANOTHER org', ownerOfBUser],
    ['a studio owner of the contract org with no org_admin grant', { ...ownerOfAUser, orgAdminOrgIds: [] }],
  ])('404 (not 403) for %s, and nothing is rendered', async (_label, u) => {
    getCurrentUser.mockResolvedValue(u)
    createServerClient.mockReturnValue(mockDb({ contract: signedNoPdf() }).db)
    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Not found')
    expect(renderAndStoreSignedContractPdf).not.toHaveBeenCalled()
  })
})

describe('POST /api/contracts/[id]/pdf — status and idempotency', () => {
  it.each(['draft', 'issued', 'viewed', 'declined', 'revoked'])('409 not_signed for status %s', async (status) => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: signedNoPdf({ status }) }).db)
    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('not_signed')
    expect(renderAndStoreSignedContractPdf).not.toHaveBeenCalled()
  })

  it('a contract that already has a PDF is a 200 no-op (generated: false), never re-rendered', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: signedNoPdf({ signed_pdf_path: 'c1/signed.pdf' }) }).db)
    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { id: 'c1', signed_pdf_path: 'c1/signed.pdf', generated: false } })
    expect(renderAndStoreSignedContractPdf).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

describe('POST /api/contracts/[id]/pdf — generation', () => {
  it.each([
    ['a master', masterUser],
    ['an org admin of the contract org', ownerOfAUser],
  ])('%s renders through the shared helper with the row, template name and studio zone, and gets the path back', async (_label, u) => {
    getCurrentUser.mockResolvedValue(u)
    const contract = signedNoPdf()
    const { db } = mockDb({ contract })
    createServerClient.mockReturnValue(db)

    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { id: 'c1', signed_pdf_path: 'c1/signed.pdf', generated: true } })
    expect(renderAndStoreSignedContractPdf).toHaveBeenCalledTimes(1)
    const args = renderAndStoreSignedContractPdf.mock.calls[0][0]
    expect(args.db).toBe(db)
    expect(args.contract).toBe(contract)
    expect(args.templateName).toBe('Coach Contract')
    expect(args.zone).toBe('Europe/Dublin')
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.pdf_generated',
      target: expect.objectContaining({ resource: 'contracts/c1' }),
      details: expect.objectContaining({ signed_pdf_path: 'c1/signed.pdf' }),
    }))
  })

  it('500 with the helper\'s reason when the render or store fails; no audit row', async () => {
    getCurrentUser.mockResolvedValue(masterUser)
    createServerClient.mockReturnValue(mockDb({ contract: signedNoPdf() }).db)
    renderAndStoreSignedContractPdf.mockResolvedValueOnce({ pdfBuffer: null, pdfPath: null, error: 'render failed: boom' })

    const res = await POST(POST_REQUEST, { params: { id: 'c1' } })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/render failed: boom/)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
