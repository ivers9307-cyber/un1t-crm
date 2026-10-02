// C120 GATES-3 (c) — /contracts/issue and the /contracts list's write
// affordances judged at the org (GATES-2's contract-gates helpers), never at
// the ACTIVE studio's role (`user.role`).
//   • /contracts/issue: POST /api/contracts' coarse rule, canManageContractsSomewhere
//     (the wizard's template list is every org the caller manages).
//   • /contracts list: Templates + Issue shown on canManageContractsInOrg at the
//     ACTIVE org, whose contracts the list shows and whose templates the
//     Templates page manages.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => {
  const chain = { select: () => chain, order: () => chain, eq: () => chain, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
  return { createServerClient: vi.fn(() => ({ from: () => chain })) }
})
vi.mock('@/components/ContractIssueWizard', () => ({ default: function ContractIssueWizard() { return null } }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

import IssueContractPage from './issue/page.js'
import ContractsAdminPage from './page.js'
import ContractIssueWizard from '@/components/ContractIssueWizard'
import { getCurrentUser } from '@/lib/auth'

const ORG_X = 'org-x'
const ORG_Y = 'org-y'
// Owner at Y, manager at X (active): user.role is 'manager'.
const ownerYManagerXActive = {
  id: 'u1', isMaster: false, role: 'manager', full_name: 'Owner Y',
  rolesByLocation: { 'loc-x': 'manager', 'loc-y': 'owner' },
  locations: [{ id: 'loc-x', organization_id: ORG_X, role: 'manager' }, { id: 'loc-y', organization_id: ORG_Y, role: 'owner' }],
  activeLocation: { id: 'loc-x', organization_id: ORG_X },
  activeOrganization: { id: ORG_X },
  assignmentsByLocation: { 'loc-x': { role: 'manager', permissions: { contracts: true } } },
  activeAssignment: { role: 'manager', permissions: { contracts: true } },
}
const ownerYActive = { ...ownerYManagerXActive, role: 'owner', activeLocation: { id: 'loc-y', organization_id: ORG_Y }, activeOrganization: { id: ORG_Y },
  assignmentsByLocation: { 'loc-y': { role: 'owner', permissions: {} } }, activeAssignment: { role: 'owner', permissions: {} } }
// Org admin of X whose own assignment at the active studio is staff.
const adminXStaffActive = {
  id: 'u2', isMaster: false, role: 'staff', full_name: 'Admin X', orgAdminOrgIds: [ORG_X],
  rolesByLocation: { 'loc-x': 'staff' },
  locations: [{ id: 'loc-x', organization_id: ORG_X, role: 'staff' }],
  activeLocation: { id: 'loc-x', organization_id: ORG_X }, activeOrganization: { id: ORG_X },
  assignmentsByLocation: { 'loc-x': { role: 'staff', permissions: { contracts: true } } },
  activeAssignment: { role: 'staff', permissions: { contracts: true } },
}
const managerOnly = {
  id: 'u3', isMaster: false, role: 'manager', full_name: 'Manager',
  rolesByLocation: { 'loc-x': 'manager' },
  locations: [{ id: 'loc-x', organization_id: ORG_X, role: 'manager' }],
  activeLocation: { id: 'loc-x', organization_id: ORG_X }, activeOrganization: { id: ORG_X },
  assignmentsByLocation: { 'loc-x': { role: 'manager', permissions: { contracts: true } } },
  activeAssignment: { role: 'manager', permissions: { contracts: true } },
}

function findAll(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}
const hrefs = (tree) => findAll(tree, (n) => typeof n.props?.href === 'string').map((n) => n.props.href)

beforeEach(() => vi.clearAllMocks())

describe('/contracts/issue (GATES-3: POST /api/contracts\' coarse rule)', () => {
  it.each([
    ['an owner of another org whose ACTIVE role is manager (main: redirected)', ownerYManagerXActive],
    ['an org admin whose own role at the active studio is staff (main: redirected)', adminXStaffActive],
  ])('%s: the wizard', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const tree = await IssueContractPage({ searchParams: Promise.resolve({}) })
    expect(findAll(tree, (n) => n.type === ContractIssueWizard)).toHaveLength(1)
  })
  it('a manager who owns no org: sent home', async () => {
    getCurrentUser.mockResolvedValue(managerOnly)
    await expect(IssueContractPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})

describe('/contracts list canWrite (GATES-3: manages the ACTIVE org)', () => {
  it('an org admin of the active org whose role there is staff gets Templates + Issue (main: none)', async () => {
    getCurrentUser.mockResolvedValue(adminXStaffActive)
    const tree = await ContractsAdminPage()
    expect(hrefs(tree)).toEqual(expect.arrayContaining(['/contracts/templates', '/contracts/issue']))
  })
  it('an owner at the active studio gets them', async () => {
    getCurrentUser.mockResolvedValue(ownerYActive)
    const tree = await ContractsAdminPage()
    expect(hrefs(tree)).toEqual(expect.arrayContaining(['/contracts/templates', '/contracts/issue']))
  })
  it('a contracts-permission manager of the active org gets the read-only list', async () => {
    getCurrentUser.mockResolvedValue(managerOnly)
    const tree = await ContractsAdminPage()
    expect(hrefs(tree)).not.toContain('/contracts/issue')
    expect(hrefs(tree)).not.toContain('/contracts/templates')
  })
  it('an owner of ANOTHER org, managing the active one only by the contracts permission, gets the read-only list', async () => {
    getCurrentUser.mockResolvedValue(ownerYManagerXActive)
    const tree = await ContractsAdminPage()
    expect(hrefs(tree)).not.toContain('/contracts/issue')
  })
})
