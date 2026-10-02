// C116 GATES-2 — the contract action routes judge the CONTRACT's organisation.
//
// revoke, resend, send and discard refused anyone whose ACTIVE studio role was
// not owner (`user.role`), before looking at the contract. So an owner of org Y
// working from a studio of org X where they are a manager, and an org admin
// whose own assignment at the active studio is not owner, were refused
// contracts their org-ownership lets them manage (the org check below it, and
// GET /api/contracts/[id] and /pdf, already let them in). The decision is now
// "master, or owner/admin of the contract's org"; the 404 for a foreign org
// is unchanged.
//
// C18 ORGROLE.1 (Richard, 1 Oct 2026): "manages the org" is now an
// ORGANISATION ADMIN of it (master or an org_admin grant). A studio owner in
// the org with no grant is refused at the coarse check (403, before any read).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/contracts-email', () => ({
  sendContractIssuedEmail: vi.fn(async () => ({ ok: true })),
  sendContractRevokedEmail: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/contracts-notify', () => ({ notifyContractIssued: vi.fn(async () => ({ emailResult: { ok: true } })) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { getCurrentUser } from '@/lib/auth'
import * as revoke from '@/app/api/contracts/[id]/revoke/route.js'
import * as resend from '@/app/api/contracts/[id]/resend/route.js'
import * as send from '@/app/api/contracts/[id]/send/route.js'
import * as discard from '@/app/api/contracts/[id]/discard/route.js'

const ORG_X = 'org-x'
const ORG_Y = 'org-y'
const LOC_X = 'loc-x'
const LOC_Y = 'loc-y'

// Active at X; the contract is in Y.
const managerXOwnerY = {
  id: 'u1', isMaster: false, role: 'manager',
  rolesByLocation: { [LOC_X]: 'manager', [LOC_Y]: 'owner' },
  locations: [{ id: LOC_X, organization_id: ORG_X }, { id: LOC_Y, organization_id: ORG_Y }],
  orgAdminOrgIds: [],
}
const orgAdminYStaffAtActive = {
  id: 'u2', isMaster: false, role: 'staff',
  rolesByLocation: { [LOC_Y]: 'staff' },
  locations: [{ id: LOC_Y, organization_id: ORG_Y }],
  orgAdminOrgIds: [ORG_Y],
}
const ownerXStaffY = {
  id: 'u3', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_X]: 'owner', [LOC_Y]: 'staff' },
  locations: [{ id: LOC_X, organization_id: ORG_X }, { id: LOC_Y, organization_id: ORG_Y }],
  orgAdminOrgIds: [],
}
const staffEverywhere = {
  id: 'u4', isMaster: false, role: 'staff',
  rolesByLocation: { [LOC_Y]: 'staff' },
  locations: [{ id: LOC_Y, organization_id: ORG_Y }],
  orgAdminOrgIds: [],
}

const req = (body) => new Request('http://localhost/api/contracts/c1/x', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
})
const props = { params: Promise.resolve({ id: 'c1' }) }

const ROUTES = [
  ['revoke', () => revoke.POST(req({ revoked_reason: 'Wrong template' }), props), 'issued'],
  ['resend', () => resend.POST(req(), props), 'issued'],
  ['send', () => send.POST(req(), props), 'draft'],
  ['discard', () => discard.POST(req(), props), 'draft'],
]

let tables
function seed(status) {
  tables = {
    contracts: [{ id: 'c1', status, organization_id: ORG_Y, location_id: LOC_Y, profile_id: 'p1', template_id: 't1' }],
    contract_templates: [{ id: 't1', name: 'FTE' }],
  }
  db = makeFakeDb(tables)
}

beforeEach(() => vi.clearAllMocks())

describe.each(ROUTES)('POST /api/contracts/[id]/%s', (_name, call, status) => {
  it('a studio owner in the contract\'s org with no org_admin grant: 403 before any read (C18; GATES-2: 200)', async () => {
    seed(status); getCurrentUser.mockResolvedValue(managerXOwnerY)
    expect((await call()).status).toBe(403)
    expect(tables.contracts[0].status).toBe(status)
  })
  it('an org admin of the contract\'s org who is not owner at the active studio (main: 403)', async () => {
    seed(status); getCurrentUser.mockResolvedValue(orgAdminYStaffAtActive)
    expect((await call()).status).toBe(200)
  })
  it('an org admin of ANOTHER org, owner at the active studio and staff in the contract\'s org: 404', async () => {
    seed(status); getCurrentUser.mockResolvedValue({ ...ownerXStaffY, orgAdminOrgIds: [ORG_X] })
    expect((await call()).status).toBe(404)
    expect(tables.contracts[0].status).toBe(status)
  })
  it('a studio owner with no grant anywhere: 403 before any read (C18; GATES-2: 404)', async () => {
    seed(status); getCurrentUser.mockResolvedValue(ownerXStaffY)
    expect((await call()).status).toBe(403)
    expect(tables.contracts[0].status).toBe(status)
  })
  it('owner of no org: 403 before any read (unchanged)', async () => {
    seed(status); getCurrentUser.mockResolvedValue(staffEverywhere)
    expect((await call()).status).toBe(403)
  })
})
