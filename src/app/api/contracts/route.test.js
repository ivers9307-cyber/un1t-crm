// Route-level tests for /api/contracts.
//
// GET — SECURITY REGRESSION GUARD (C1, 2026-06 platform audit). The
// route runs as service-role (RLS bypassed), so before this fix it
// SELECTed every contract and returned the lot to ANY authenticated
// caller — comp variables, signatures, signed_ip across all tenants.
// These tests pin the application-layer scoping that replicates
// mig 106's model:
//   master  → no filter (sees all)
//   owner   → profile_id = self OR organization_id IN (owned orgs)
//   else    → profile_id = self only
//
// POST — SECURITY REGRESSION GUARD (SAAS-5). The issue path looked the
// template up by id with NO org check, so an owner of org A could issue
// a contract from org B's template — rendering B's body_markdown (comp
// copy) AND anchoring the new contract to org B via
// template.organization_id. These tests pin the template-pick scoping:
// non-master issuers only reach templates in orgs they own (NULL-org
// templates are master-only), foreign ids 404 as 'Template not found'.
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contracts-email', () => ({ sendContractIssuedEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
// CONTRACTS-VARS.2 — every issue-path test below goes through
// getLocationBranding(); stub it so tests don't need a
// company_settings/org_settings mock on every `db.from`. Individual
// tests override the resolved value with mockResolvedValueOnce where
// the company_name substitution itself is under test.
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T', logoUrl: null, faviconUrl: null })),
}))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'
import { sendContractIssuedEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'
import { getLocationBranding } from '@/lib/location-branding'

const ORG_A = 'org-a'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

// ─── DB mock ─────────────────────────────────────────────────────
//
// GET builds: from('contracts').select(...).order(...) then optionally
// .or(...) (owner) or .eq(...) (plain caller), then awaits the builder.
// master awaits straight after .order(). We record which filter was
// applied so the test can assert the scoping branch taken.
function mockDb({ data = [], error = null } = {}) {
  const calls = { or: [], eq: [], neq: [] }
  const result = { data, error }
  const builder = {}
  builder.or = vi.fn((arg) => { calls.or.push(arg); return builder })
  builder.eq = vi.fn((...args) => { calls.eq.push(args); return builder })
  builder.neq = vi.fn((...args) => { calls.neq.push(args); return builder })
  // Thenable: `await query` resolves to the PostgREST-shaped result.
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  const order = vi.fn(() => builder)
  const select = vi.fn(() => ({ order }))
  const from = vi.fn((table) => {
    if (table !== 'contracts') throw new Error(`unexpected table ${table}`)
    return { select }
  })
  return { db: { from }, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const FAKE_REQUEST = new Request('https://example.com/api/contracts')

describe('GET /api/contracts — list scoping', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(401)
  })

  it('master gets an UNFILTERED query (no .or / .eq scoping applied)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    const { db, calls } = mockDb({ data: [{ id: 'c1' }, { id: 'c2' }] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(calls.or).toHaveLength(0)
    expect(calls.eq).toHaveLength(0)
  })

  it('owner is scoped to own contracts OR contracts in orgs they own', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'owner-a', isMaster: false, role: 'owner',
      rolesByLocation: { [LOC_A1]: 'owner' },
      locations: [{ id: LOC_A1, organization_id: ORG_A }],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(200)
    expect(calls.or).toHaveLength(1)
    // Both arms present: own contracts (drafts excluded — see the
    // CONTRACTS-DRAFT.1 test below) AND owned-org contracts (drafts
    // included there — that's the issuer/admin view).
    expect(calls.or[0]).toContain('profile_id.eq.owner-a')
    expect(calls.or[0]).toContain(`organization_id.in.(${ORG_A})`)
    // No bare .eq scoping — the owner uses the .or() branch.
    expect(calls.eq).toHaveLength(0)
  })

  it('plain staff (owns no org) is scoped to their OWN contracts only', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'staff-1', isMaster: false, role: 'staff',
      rolesByLocation: { [LOC_B1]: 'staff' },
      locations: [{ id: LOC_B1, organization_id: 'org-b' }],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(200)
    expect(calls.or).toHaveLength(0)
    expect(calls.eq).toContainEqual(['profile_id', 'staff-1'])
    expect(calls.neq).toContainEqual(['status', 'draft'])
  })

  // CONTRACTS-DRAFT.1 — a draft must never appear in a recipient's OWN
  // list (this route is what mobile's listContracts() hits for "my
  // contracts"). The org-owner arm is deliberately NOT excluded —
  // an owner reviewing their org's contracts still needs to see
  // drafts so they can send or discard them.
  describe('CONTRACTS-DRAFT.1 — drafts excluded from the recipient-self arm', () => {
    it("excludes drafts from a plain staff caller's own-contracts filter", async () => {
      getCurrentUser.mockResolvedValue({
        id: 'staff-1', isMaster: false, role: 'staff',
        rolesByLocation: { [LOC_B1]: 'staff' },
        locations: [{ id: LOC_B1, organization_id: 'org-b' }],
      })
      const { db, calls } = mockDb({ data: [] })
      createServerClient.mockReturnValue(db)
      await GET(FAKE_REQUEST)
      expect(calls.neq).toContainEqual(['status', 'draft'])
    })

    it("excludes drafts from the profile_id arm of an owner's .or() filter (org arm untouched)", async () => {
      getCurrentUser.mockResolvedValue({
        id: 'owner-a', isMaster: false, role: 'owner',
        rolesByLocation: { [LOC_A1]: 'owner' },
        locations: [{ id: LOC_A1, organization_id: ORG_A }],
      })
      const { db, calls } = mockDb({ data: [] })
      createServerClient.mockReturnValue(db)
      await GET(FAKE_REQUEST)
      expect(calls.or[0]).toContain('and(profile_id.eq.owner-a,status.neq.draft)')
      expect(calls.or[0]).toContain(`organization_id.in.(${ORG_A})`)
    })

    it('master still gets an unfiltered query (drafts visible everywhere for master)', async () => {
      getCurrentUser.mockResolvedValue({
        id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
      })
      const { db, calls } = mockDb({ data: [] })
      createServerClient.mockReturnValue(db)
      await GET(FAKE_REQUEST)
      expect(calls.or).toHaveLength(0)
      expect(calls.eq).toHaveLength(0)
      expect(calls.neq).toHaveLength(0)
    })
  })

  it('surfaces a DB error as a 500', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    createServerClient.mockReturnValue(mockDb({ error: { message: 'boom' } }).db)
    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(500)
  })
})

// ─── POST (issue) — template-pick scoping ────────────────────────
//
// The issue flow reads contract_templates first, then profiles, then
// inserts into contracts. For the scoping tests we only need the flow
// to reach (or be stopped at) the template gate: the mock resolves the
// template lookup from a fixture and returns null for the recipient,
// so a caller who CLEARS the gate surfaces as 404 'Recipient not
// found' while a caller the gate stops sees 404 'Template not found'
// — and we assert no contracts insert ever fires either way.

const TPL_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const TPL_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const TPL_NULL = 'cccccccc-0000-0000-0000-000000000001'
const RECIPIENT = 'eeeeeeee-0000-0000-0000-000000000001'

function issueMockDb() {
  const templates = [
    { id: TPL_A, organization_id: ORG_A, body_markdown: 'A body', variables_schema: [], employment_type: 'both', active: true },
    { id: TPL_B, organization_id: 'org-b', body_markdown: 'B comp copy', variables_schema: [], employment_type: 'both', active: true },
    { id: TPL_NULL, organization_id: null, body_markdown: 'legacy', variables_schema: [], employment_type: 'both', active: true },
  ]
  const calls = { contractsInsert: [] }
  const from = vi.fn((table) => {
    if (table === 'contract_templates') {
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: templates.find(r => filters.every(f => f(r))) || null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'profiles') {
      // Recipient never resolves — the tests only exercise the
      // template gate, and 'Recipient not found' proves it was passed.
      const b = { eq: vi.fn(() => b), maybeSingle: vi.fn(async () => ({ data: null, error: null })) }
      return { select: vi.fn(() => b) }
    }
    if (table === 'contracts') {
      const insert = vi.fn((row) => {
        calls.contractsInsert.push(row)
        const b = { select: vi.fn(() => b), single: vi.fn(async () => ({ data: { id: 'c-new', ...row }, error: null })) }
        return b
      })
      return { insert }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, calls }
}

const issueReq = (template_id) => new Request('https://example.com/api/contracts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    template_id,
    profile_id: RECIPIENT,
    variables: {},
    issuer_signature: 'Richard Ivers',
  }),
})

const OWNER_A = {
  id: 'owner-a', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}

const MASTER = {
  id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
}

describe('POST /api/contracts — template-pick scoping', () => {
  it("owner of org A cannot issue from org B's template — 404, nothing inserted", async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db, calls } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_B))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Template not found')
    expect(calls.contractsInsert).toHaveLength(0)
  })

  it('owner of org A cannot issue from a NULL-org template (master-only) — 404, nothing inserted', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db, calls } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_NULL))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Template not found')
    expect(calls.contractsInsert).toHaveLength(0)
  })

  it("owner of org A passes the gate on their OWN template (flow proceeds to recipient lookup)", async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_A))
    const body = await res.json()
    // Recipient mock resolves null, so the gate having been cleared
    // surfaces as the NEXT 404 in the flow — not the template one.
    expect(res.status).toBe(404)
    expect(body.error).toBe('Recipient not found')
  })

  it('master passes the gate on any template, including NULL-org', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueMockDb()
    createServerClient.mockReturnValue(db)

    for (const tpl of [TPL_B, TPL_NULL]) {
      const res = await POST(issueReq(tpl))
      const body = await res.json()
      expect(res.status).toBe(404)
      expect(body.error).toBe('Recipient not found')
    }
  })
})

// ─── POST (issue) — CONTRACTS-EDIT.1 body_override ──────────────
//
// A happy-path mock that resolves the recipient (unlike issueMockDb
// above, which deliberately stops at the template gate) so the flow
// reaches the render + insert step. TPL_EDIT has a body with a
// {{full_name}} placeholder (auto-fillable from the recipient, so a
// plain issue with no override renders clean) — the override tests
// then swap in either a clean or a placeholder-carrying replacement
// body to exercise CONTRACTS-EDIT.1's leftover check.

const TPL_EDIT = 'dddddddd-0000-0000-0000-000000000001'

function issueHappyPathMockDb() {
  const recipient = {
    id: RECIPIENT,
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    role: 'staff',
    employment_type: 'fte',
    annual_salary: 50000,
    hourly_rate: null,
    overtime_rate: null,
    contracted_hours_per_week: 40,
    profile_locations: [
      { location_id: LOC_A1, is_default: true, location: { id: LOC_A1, organization_id: ORG_A } },
    ],
  }
  const templates = [
    { id: TPL_EDIT, organization_id: ORG_A, body_markdown: 'Hello {{full_name}}, salary {{annual_salary}}.', variables_schema: [], employment_type: 'both', active: true },
  ]
  const calls = { contractsInsert: [] }
  const from = vi.fn((table) => {
    if (table === 'contract_templates') {
      // Both the initial template lookup and the post-insert
      // name-for-the-email-subject lookup land here; both filter by
      // 'id' only, so one mock handles both call sites.
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: templates.find(r => filters.every(f => f(r))) || null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'profiles') {
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: filters.every(f => f(recipient)) ? recipient : null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'contracts') {
      const insert = vi.fn((row) => {
        calls.contractsInsert.push(row)
        const b = { select: vi.fn(() => b), single: vi.fn(async () => ({ data: { id: 'c-new', ...row }, error: null })) }
        return b
      })
      return { insert }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, calls }
}

const issueReqFull = (extra = {}) => new Request('https://example.com/api/contracts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    template_id: TPL_EDIT,
    profile_id: RECIPIENT,
    variables: {},
    issuer_signature: 'Richard Ivers',
    ...extra,
  }),
})

describe('POST /api/contracts — CONTRACTS-EDIT.1 body_override', () => {
  it('accepts body_override and stores it as body_rendered verbatim (variables_data still the merged auto-fill map)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ body_override: 'Custom hand-edited text for Jane.' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(calls.contractsInsert).toHaveLength(1)
    expect(calls.contractsInsert[0].body_rendered).toBe('Custom hand-edited text for Jane.')
    // variables_data is unaffected by the override — it's still the
    // merged profile-auto-fill + custom-variable map.
    expect(calls.contractsInsert[0].variables_data.full_name).toBe('Jane Doe')
  })

  it('rejects a body_override that still has an unmapped {{placeholder}} — 400 with unmapped_keys', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ body_override: 'Still has {{mystery_var}} left in it.' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.unmapped_keys).toEqual(['mystery_var'])
    expect(calls.contractsInsert).toHaveLength(0)
  })

  it('records details.body_edited: true on the audit event when an override was used', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ body_override: 'Custom hand-edited text for Jane.' }))
    expect(res.status).toBe(200)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.issued',
      details: expect.objectContaining({ body_edited: true }),
    }))
  })

  it('records details.body_edited: false when no override was used', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull())
    expect(res.status).toBe(200)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ body_edited: false }),
    }))
  })
})

// ─── POST (issue) — CONTRACTS-VARS.2 location auto-fill variables ──
//
// Location vars (location_name/_address/_phone/_email/company_name)
// are resolved server-side from the recipient's profile_locations
// embed (the SAME location row the route already picks as
// locationId) + getLocationBranding(), then folded into the merged
// variable map BEFORE the render — so a template referencing
// {{location_name}} renders clean with no issuer input required.

const TPL_LOC = 'ffffffff-0000-0000-0000-000000000001'

function issueLocationVarsMockDb({ locationOverrides = {} } = {}) {
  const recipient = {
    id: RECIPIENT,
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    role: 'staff',
    employment_type: 'fte',
    annual_salary: 50000,
    hourly_rate: null,
    overtime_rate: null,
    contracted_hours_per_week: 40,
    profile_locations: [
      {
        location_id: LOC_A1,
        is_default: true,
        location: {
          id: LOC_A1,
          organization_id: ORG_A,
          name: 'UN1T Stillorgan',
          address: 'Stillorgan SC, Dublin',
          phone: '01 234 5678',
          email: 'stillorgan@un1tdublin.com',
          ...locationOverrides,
        },
      },
    ],
  }
  const templates = [
    {
      id: TPL_LOC,
      organization_id: ORG_A,
      body_markdown: 'Welcome {{full_name}} to {{location_name}} at {{location_address}}, issued by {{company_name}}.',
      variables_schema: [],
      employment_type: 'both',
      active: true,
    },
  ]
  const calls = { contractsInsert: [] }
  const from = vi.fn((table) => {
    if (table === 'contract_templates') {
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: templates.find(r => filters.every(f => f(r))) || null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'profiles') {
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: filters.every(f => f(recipient)) ? recipient : null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'contracts') {
      const insert = vi.fn((row) => {
        calls.contractsInsert.push(row)
        const b = { select: vi.fn(() => b), single: vi.fn(async () => ({ data: { id: 'c-new', ...row }, error: null })) }
        return b
      })
      return { insert }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, calls }
}

const issueLocReq = (extra = {}) => new Request('https://example.com/api/contracts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    template_id: TPL_LOC,
    profile_id: RECIPIENT,
    variables: {},
    issuer_signature: 'Richard Ivers',
    ...extra,
  }),
})

describe('POST /api/contracts — CONTRACTS-VARS.2 location auto-fill variables', () => {
  it("renders {{location_name}}/{{location_address}} from the recipient's resolved location and {{company_name}} from branding, with variables_data reflecting the same values", async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueLocationVarsMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueLocReq())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(calls.contractsInsert[0].body_rendered).toBe(
      'Welcome Jane Doe to UN1T Stillorgan at Stillorgan SC, Dublin, issued by UN1T.'
    )
    expect(calls.contractsInsert[0].variables_data.location_name).toBe('UN1T Stillorgan')
    expect(calls.contractsInsert[0].variables_data.location_address).toBe('Stillorgan SC, Dublin')
    expect(calls.contractsInsert[0].variables_data.company_name).toBe('UN1T')
    expect(getLocationBranding).toHaveBeenCalledWith(db, LOC_A1)
  })

  it('a same-named custom variable overrides the auto-filled location value', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueLocationVarsMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueLocReq({ variables: { location_name: 'Custom Venue Name' } }))
    expect(res.status).toBe(200)
    expect(calls.contractsInsert[0].body_rendered).toContain('Custom Venue Name')
    expect(calls.contractsInsert[0].body_rendered).not.toContain('UN1T Stillorgan')
  })

  it('resolves branding-derived company_name even when getLocationBranding returns a different brand', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    getLocationBranding.mockResolvedValueOnce({ companyName: 'CCF Autos', logoUrl: null, faviconUrl: null })
    const { db, calls } = issueLocationVarsMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueLocReq())
    expect(res.status).toBe(200)
    expect(calls.contractsInsert[0].body_rendered).toContain('issued by CCF Autos.')
  })

  it('a location field left unset leaves that placeholder unresolved — issue is rejected, not silently blank', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueLocationVarsMockDb({ locationOverrides: { name: null } })
    createServerClient.mockReturnValue(db)

    const res = await POST(issueLocReq())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.unmapped_keys).toEqual(['location_name'])
    expect(calls.contractsInsert).toHaveLength(0)
  })
})

// ─── POST (issue) — CONTRACTS-DRAFT.1 save_as_draft ──────────────
//
// A save_as_draft:true request must insert with status:'draft' and
// SKIP the notification path entirely — no email, no push — logging
// contract.drafted instead of contract.issued. The response carries
// no `warning` (nothing was attempted, so there's nothing to warn
// about).

describe('POST /api/contracts — CONTRACTS-DRAFT.1 save_as_draft', () => {
  it("inserts with status: 'draft' and returns it with no warning key", async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ save_as_draft: true }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(calls.contractsInsert).toHaveLength(1)
    expect(calls.contractsInsert[0].status).toBe('draft')
    expect(body.warning).toBeUndefined()
  })

  it('never sends the issue email or push for a draft', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ save_as_draft: true }))
    expect(res.status).toBe(200)
    expect(sendContractIssuedEmail).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('logs contract.drafted instead of contract.issued', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull({ save_as_draft: true }))
    expect(res.status).toBe(200)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.drafted',
    }))
  })

  it('a normal issue (no save_as_draft) still inserts with no explicit status key and DOES notify', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, calls } = issueHappyPathMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReqFull())
    expect(res.status).toBe(200)
    expect(calls.contractsInsert[0].status).toBeUndefined()
    expect(sendContractIssuedEmail).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract.issued',
    }))
  })
})
