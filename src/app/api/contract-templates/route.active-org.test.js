// C116 GATES-2 — POST /api/contract-templates creates in the ACTIVE org, so it
// asks whether the caller manages contracts in THAT org.
//
// Main let through anyone whose active role was owner OR who admins ANY org:
// an org admin of X working from a studio of Y where they are a manager
// created a template in Y. And the /contracts/templates pages refused an org
// admin whose own assignment at the active studio is not owner, which the
// route let in. Both now ask canManageContractsInOrg(user, activeOrganization).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const body = { name: 'FTE', body_markdown: 'Hello {{name}}' }
const post = () => POST(new Request('http://localhost/api/contract-templates', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

const at = (orgId, extra) => ({
  id: 'u1', isMaster: false,
  locations: [{ id: 'loc-y', organization_id: 'org-y' }],
  activeOrganization: { id: orgId },
  orgAdminOrgIds: [],
  ...extra,
})

let tables
beforeEach(() => {
  tables = { contract_templates: [] }
  db = makeFakeDb(tables)
})

describe('POST /api/contract-templates', () => {
  it('an org admin of ANOTHER org, manager at the active studio: 403, nothing written (main: 200, created in the active org)', async () => {
    getCurrentUser.mockResolvedValue(at('org-y', { role: 'manager', rolesByLocation: { 'loc-y': 'manager' }, orgAdminOrgIds: ['org-x'] }))
    expect((await post()).status).toBe(403)
    expect(tables.contract_templates).toHaveLength(0)
  })
  it('an org admin of the active org whose assignment there is staff: created in that org', async () => {
    getCurrentUser.mockResolvedValue(at('org-y', { role: 'staff', rolesByLocation: { 'loc-y': 'staff' }, orgAdminOrgIds: ['org-y'] }))
    expect((await post()).status).toBe(200)
    expect(tables.contract_templates[0].organization_id).toBe('org-y')
  })
  it('an owner at the active studio: created (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(at('org-y', { role: 'owner', rolesByLocation: { 'loc-y': 'owner' } }))
    expect((await post()).status).toBe(200)
  })
  it('a manager: 403 (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(at('org-y', { role: 'manager', rolesByLocation: { 'loc-y': 'manager' } }))
    expect((await post()).status).toBe(403)
  })
})
