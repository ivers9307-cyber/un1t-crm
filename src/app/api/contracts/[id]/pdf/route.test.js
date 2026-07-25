// Route-level tests for GET /api/contracts/[id]/pdf.
//
// SECURITY GUARD, same class as the [id] GET tests next door. The route
// runs as service role (RLS bypassed) AND it hands back a signed URL to
// a private-bucket object, so a gate slip here would leak somebody's
// employment contract as a downloadable file to any authenticated
// caller. These tests pin: recipient / master / org-owner get the
// redirect, everyone else gets a 404 (not 403 — ids stay
// non-enumerable), and a contract with no stored PDF is also a 404.
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser and the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

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
  it('404s when signed_pdf_path is null even for an authorized caller', async () => {
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
