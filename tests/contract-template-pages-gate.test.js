// C116 GATES-2 — the /contracts/templates pages ask what their routes ask.
//
// All three redirected anyone whose ACTIVE studio role was not owner. The
// templates routes (GET/PATCH /api/contract-templates/[id]) let in an org
// admin whatever their own assignment, so an org admin who is staff at the
// active studio was bounced off templates the API served them. The list and
// new pages now ask canManageContractsInOrg of the ACTIVE org (the org they
// list and create in); the edit page asks it of the TEMPLATE's org.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pageDb, navigationMock } from './helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/ContractTemplateForm', () => ({ default: () => null }))

import ListPage from '@/app/(team)/contracts/templates/page.js'
import NewPage from '@/app/(team)/contracts/templates/new/page.js'
import EditPage from '@/app/(team)/contracts/templates/[id]/page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_Y = 'org-y'
const inY = (extra) => ({
  id: 'u1', isMaster: false,
  locations: [{ id: 'loc-y', organization_id: ORG_Y }],
  activeOrganization: { id: ORG_Y },
  orgAdminOrgIds: [],
  ...extra,
})
const adminStaff = inY({ role: 'staff', rolesByLocation: { 'loc-y': 'staff' }, orgAdminOrgIds: [ORG_Y] })
const owner = inY({ role: 'owner', rolesByLocation: { 'loc-y': 'owner' } })
const manager = inY({ role: 'manager', rolesByLocation: { 'loc-y': 'manager' } })
// Owner of another org (via loc-x) while active in Y, where they are a manager.
const ownerElsewhere = inY({
  role: 'manager', rolesByLocation: { 'loc-y': 'manager', 'loc-x': 'owner' },
  locations: [{ id: 'loc-y', organization_id: ORG_Y }, { id: 'loc-x', organization_id: 'org-x' }],
})

const editProps = { params: Promise.resolve({ id: 'tpl-1' }) }
beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(pageDb({
    contract_templates: { id: 'tpl-1', organization_id: ORG_Y, name: 'FTE', version: 1, active: true, body_markdown: 'x', variables_schema: [], employment_type: 'both' },
    contract_template_versions: [],
  }))
})

describe.each([
  ['/contracts/templates', () => ListPage()],
  ['/contracts/templates/new', () => NewPage()],
  ['/contracts/templates/[id]', () => EditPage(editProps)],
])('%s', (_path, render) => {
  it('opens for an org admin of the org whose assignment at the active studio is staff (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(adminStaff)
    await expect(render()).resolves.toBeTruthy()
  })
  it('opens for an owner (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    await expect(render()).resolves.toBeTruthy()
  })
  it('refuses a manager (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    await expect(render()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})

describe('an owner of ANOTHER org, active where they are a manager', () => {
  it('list and new: redirected (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(ownerElsewhere)
    await expect(ListPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    await expect(NewPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it("edit: a template of the active org is not theirs to manage, 404 like the route (main: redirected)", async () => {
    getCurrentUser.mockResolvedValue(ownerElsewhere)
    await expect(EditPage(editProps)).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
})
