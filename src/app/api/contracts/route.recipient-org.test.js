// C140 CONTRACTRECIPIENT.1 (security; folds C138 d) — POST /api/contracts
// checked the TEMPLATE's org against the issuer but never the RECIPIENT: an
// owner of org A could issue org A's template to a person in org B, and the
// contract rendered that person's name, email and pay. A template with an org
// now needs a recipient with a studio in that org (else the same 404 as an
// unknown id, so other orgs' people cannot be probed). The contract's studio
// is the recipient's studio IN that org (their default there first); an
// explicit location_id outside it is a 400. A null-org template (master-only)
// keeps its old behaviour. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contracts-email', () => ({ sendContractIssuedEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'Studio', logoUrl: null, faviconUrl: null })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'a1000000-0000-4000-8000-0000000000a1'
const LOC_A2 = 'a2000000-0000-4000-8000-0000000000a2'
const LOC_B1 = 'b1000000-0000-4000-8000-0000000000b1'
const TPL_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TPL_NULL = 'cccccccc-0000-4000-8000-000000000001'
const RECIPIENT = 'eeeeeeee-0000-4000-8000-000000000001'

const link = (location_id, organization_id, is_default = false) =>
  ({ location_id, is_default, location: { id: location_id, organization_id, name: location_id } })

let inserts
function makeDb(links) {
  const recipient = {
    id: RECIPIENT, full_name: 'Pat Example', email: 'pat@example.test', role: 'staff', employment_type: 'fte',
    annual_salary: null, hourly_rate: null, overtime_rate: null, contracted_hours_per_week: null,
    profile_locations: links,
  }
  const templates = [
    { id: TPL_A, organization_id: ORG_A, body_markdown: 'Hello {{full_name}}.', variables_schema: [], employment_type: 'both', active: true },
    { id: TPL_NULL, organization_id: null, body_markdown: 'Hello {{full_name}}.', variables_schema: [], employment_type: 'both', active: true },
  ]
  const lookup = (rows) => {
    const filters = []
    const b = {
      eq: vi.fn((c, v) => { filters.push((r) => r[c] === v); return b }),
      maybeSingle: vi.fn(async () => ({ data: rows.find((r) => filters.every((f) => f(r))) || null, error: null })),
    }
    return { select: vi.fn(() => b) }
  }
  return {
    from: vi.fn((table) => {
      if (table === 'contract_templates') return lookup(templates)
      if (table === 'profiles') return lookup([recipient])
      if (table === 'contracts') {
        return {
          insert: vi.fn((row) => {
            inserts.push(row)
            const b = { select: vi.fn(() => b), single: vi.fn(async () => ({ data: { id: 'c-new', ...row }, error: null })) }
            return b
          }),
        }
      }
      // org_settings etc. (the contracting entity): nothing on file.
      const b = { select: () => b, eq: () => b, in: () => b, limit: () => b, maybeSingle: async () => ({ data: null, error: null }) }
      b.then = (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
      return b
    }),
  }
}

const issue = (extra = {}) => POST(new Request('https://crm.test/api/contracts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ template_id: TPL_A, profile_id: RECIPIENT, variables: {}, issuer_signature: 'Issuer', ...extra }),
}))

// C18 ORGROLE.1 (merged from main) — issuing is for ORGANISATION ADMINS (an
// org_admin grant), so the org A issuer here holds one.
const OWNER_A = {
  id: 'owner-a', isMaster: false, role: 'owner', profileRole: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A, role: 'owner' }],
  orgAdminOrgIds: [ORG_A],
}
const MASTER = { id: 'm1', isMaster: true, role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [] }

beforeEach(() => {
  vi.clearAllMocks()
  inserts = []
})

describe('POST /api/contracts — the recipient must belong to the template\'s org (C140)', () => {
  it.each([['an org admin of org A', OWNER_A], ['a master', MASTER]])(
    '%s: org A template to a person only in org B is 404, nothing inserted (main: issued)', async (_l, caller) => {
      getCurrentUser.mockResolvedValue(caller)
      createServerClient.mockReturnValue(makeDb([link(LOC_B1, ORG_B, true)]))
      const res = await issue()
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ success: false, error: 'Recipient not found' })
      expect(inserts).toEqual([])
    })

  it('a person in org A: issued, anchored to org A at their studio there', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb([link(LOC_A1, ORG_A, true)]))
    const res = await issue()
    expect(res.status).toBe(200)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ organization_id: ORG_A, location_id: LOC_A1, profile_id: RECIPIENT })
  })

  it('a person in both orgs whose DEFAULT studio is in B: the contract takes their studio in A', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb([link(LOC_B1, ORG_B, true), link(LOC_A2, ORG_A), link(LOC_A1, ORG_A)]))
    const res = await issue()
    expect(res.status).toBe(200)
    expect(inserts[0]).toMatchObject({ organization_id: ORG_A, location_id: LOC_A2 })
  })

  it('their default studio IN org A wins over their other A studios', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb([link(LOC_A2, ORG_A), link(LOC_A1, ORG_A, true)]))
    await issue()
    expect(inserts[0].location_id).toBe(LOC_A1)
  })

  it('an explicit location_id outside the recipient\'s studios in org A: 400, nothing inserted', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb([link(LOC_B1, ORG_B, true), link(LOC_A1, ORG_A)]))
    const res = await issue({ location_id: LOC_B1 })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(inserts).toEqual([])
  })

  it('an explicit location_id that is their studio in org A: used', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb([link(LOC_A1, ORG_A, true), link(LOC_A2, ORG_A)]))
    const res = await issue({ location_id: LOC_A2 })
    expect(res.status).toBe(200)
    expect(inserts[0].location_id).toBe(LOC_A2)
  })

  it('a null-org template (master-only) keeps its old behaviour: the org comes from the recipient', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(makeDb([link(LOC_B1, ORG_B, true)]))
    const res = await issue({ template_id: TPL_NULL })
    expect(res.status).toBe(200)
    expect(inserts[0]).toMatchObject({ organization_id: ORG_B, location_id: LOC_B1 })
  })
})
