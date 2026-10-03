// WATPLROLE.1 — /communications/templates offers "+ WhatsApp" (new template)
// and hands the list its Delete / "Edit & resubmit" controls only to a caller
// the routes would accept: MANAGER_ROLES at the active studio, whose
// templates the list shows. The WhatsApp permission still decides whether the
// section shows at all (unchanged). Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(), hasPermissionForLocation: vi.fn() }))
// The email list (read only when the email permission is on) answers empty.
vi.mock('@/lib/supabase', () => {
  const chain = { select: () => chain, eq: () => chain, order: async () => ({ data: [], error: null }) }
  return { createServerClient: vi.fn(() => ({ from: () => chain })) }
})
vi.mock('@/components/WhatsappTemplatesList', () => ({ default: function WhatsappTemplatesList() { return null } }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))

import TemplatesListPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import WhatsappTemplatesList from '@/components/WhatsappTemplatesList'
import { LOC_A, LOC_B, person, MASTER } from '../../../../../tests/helpers/owner-at-location-callers.js'

// Walk a server component's returned element tree (nothing is rendered).
function findAll(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}
const NEW_WA = (n) => n.props?.href === '/communications/templates/whatsapp/new'
const LIST = (n) => n.type === WhatsappTemplatesList

const render = () => TemplatesListPage({ searchParams: Promise.resolve({ channel: 'whatsapp' }) })

beforeEach(() => {
  vi.clearAllMocks()
  // WhatsApp on, email off: the page locks to the WhatsApp channel.
  hasPermission.mockImplementation((_user, key) => key === 'whatsapp')
  // GATES-3 (b) — the manage controls also ask `whatsapp` AT the studio.
  hasPermissionForLocation.mockImplementation((_user, _loc, key) => key === 'whatsapp')
})

describe('/communications/templates — WhatsApp template controls (WATPLROLE.1)', () => {
  it.each([
    ['a manager at the active studio', person({ [LOC_B]: 'manager' }, LOC_B)],
    ['a head coach at the active studio', person({ [LOC_B]: 'head_coach' }, LOC_B)],
    ['a master', MASTER],
  ])('%s: "+ WhatsApp" offered, list gets canManage', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const tree = await render()
    expect(findAll(tree, NEW_WA)).toHaveLength(1)
    expect(findAll(tree, LIST).map((n) => n.props)).toEqual([{ locationId: caller.activeLocation.id, canManage: true }])
  })

  it.each([
    ['staff with the WhatsApp permission at the active studio', person({ [LOC_B]: 'staff' }, LOC_B)],
    ['reception at the active studio', person({ [LOC_B]: 'reception' }, LOC_B)],
    ['a manager elsewhere who is staff at the active studio', person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_B)],
  ])('%s: no "+ WhatsApp", the list is read-only', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const tree = await render()
    expect(findAll(tree, NEW_WA)).toEqual([])
    expect(findAll(tree, LIST).map((n) => n.props)).toEqual([{ locationId: LOC_B, canManage: false }])
  })

  it('without the WhatsApp permission: no WhatsApp section at all (unchanged)', async () => {
    hasPermission.mockImplementation((_user, key) => key === 'email')
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'manager' }, LOC_B))
    const tree = await render()
    expect(findAll(tree, NEW_WA)).toEqual([])
    expect(findAll(tree, LIST)).toEqual([])
  })

  it('GATES-3 (b): a manager whose `whatsapp` does not resolve AT the studio gets no manage controls', async () => {
    hasPermissionForLocation.mockImplementation(() => false)
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'manager' }, LOC_B))
    const tree = await render()
    expect(findAll(tree, NEW_WA)).toEqual([])
    expect(findAll(tree, LIST).map((n) => n.props)).toEqual([{ locationId: LOC_B, canManage: false }])
  })
})
