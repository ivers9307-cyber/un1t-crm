// /settings/landing-page has three modes (PAGES.1):
//   - no query: the Pages list (every page the caller can view);
//   - ?page=chooser: the front-page (chooser) editor, organisation admins only
//     (C141 ORGROLE.2: PUT /api/chooser-settings answers 403 to anyone else,
//     assertChooserEdit), so an owner without the grant gets the list;
//   - ?location_id=<id>: the legacy studio editor, until studio pages move to
//     the page editor in PR3.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/landing-pages', () => {
  class PageReadError extends Error {}
  return { listPagesForUser: vi.fn(), PageReadError }
})
vi.mock('@/components/LandingPageSettingsForm', () => ({ default: () => null }))
vi.mock('@/components/ChooserEditorForm', () => ({ default: () => null }))
vi.mock('@/components/landing-pages/PagesList', () => ({ default: () => null }))

import LandingPageSettingsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { listPagesForUser, PageReadError } from '@/lib/landing-pages'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import ChooserEditorForm from '@/components/ChooserEditorForm'
import PagesList from '@/components/landing-pages/PagesList'

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOC = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOC2 = 'b2b2b2b2-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeDb() {
  const tables = []
  const from = (table) => {
    tables.push(table)
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, not: () => chain, order: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res) => Promise.resolve({
        data: table === 'landing_page_settings' ? [{ location_id: LOC, public_path: 'x', locations: { name: 'X' } }] : [],
        error: null,
      }).then(res),
    }
    return chain
  }
  return { tables, from }
}

const owner = (orgAdminOrgIds) => ({
  id: 'u1', role: 'owner', isMaster: false,
  activeLocation: { id: LOC, organization_id: ORG }, activeOrganization: { id: ORG },
  locations: [
    { id: LOC2, name: 'UN1T Stillorgan', organization_id: ORG },
    { id: LOC, name: 'UN1T Hatch Street', organization_id: ORG },
  ],
  rolesByLocation: { [LOC]: 'owner', [LOC2]: 'owner' },
  orgAdminOrgIds,
})

// Every element of a returned server-component tree whose type is `type`.
function findAll(node, type, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  findAll(node.props?.children, type, out)
  return out
}
const linkHrefs = (tree) => {
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.href) out.push(n.props.href)
    walk(n.props?.children)
  }
  walk(tree)
  return out
}

const PAGE_ROWS = [{ id: 'p-1', title: 'Trial', kind: 'campaign' }]

describe('/settings/landing-page', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    createServerClient.mockReturnValue(db)
    listPagesForUser.mockReset().mockResolvedValue(PAGE_ROWS)
    hasPermissionForLocation.mockReset().mockReturnValue(true)
  })

  it('with no query renders the Pages list with the studios the caller can make a page for', async () => {
    hasPermissionForLocation.mockImplementation((_u, id) => id === LOC)
    getCurrentUser.mockResolvedValue(owner([]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({}) })
    const [list] = findAll(tree, PagesList)
    expect(list.props).toMatchObject({
      pages: PAGE_ROWS,
      studios: [{ id: LOC, name: 'UN1T Hatch Street' }],
      canCreate: true,
      canCreateAll: false,
      showFrontPage: false,
    })
    expect(listPagesForUser).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'u1' }))
    expect(db.tables).not.toContain('chooser_settings')
  })

  it('an org admin may make an all-studios page and is shown the front page link', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    getCurrentUser.mockResolvedValue(owner([ORG]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({}) })
    const [list] = findAll(tree, PagesList)
    expect(list.props).toMatchObject({ studios: [], canCreate: true, canCreateAll: true, showFrontPage: true })
  })

  it('a caller with no studio to make a page for and no org grant cannot create', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    getCurrentUser.mockResolvedValue(owner([]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({}) })
    expect(findAll(tree, PagesList)[0].props).toMatchObject({ canCreate: false, canCreateAll: false })
  })

  it('an unreadable list shows a message, never an empty list', async () => {
    listPagesForUser.mockRejectedValue(new PageReadError('down'))
    getCurrentUser.mockResolvedValue(owner([]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({}) })
    expect(findAll(tree, PagesList)).toHaveLength(0)
    expect(JSON.stringify(tree)).toContain('could not be loaded')
  })

  it('an owner without an org_admin grant asking for the chooser gets the list, never the chooser', async () => {
    getCurrentUser.mockResolvedValue(owner([]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({ page: 'chooser' }) })
    expect(db.tables).not.toContain('chooser_settings')
    expect(findAll(tree, ChooserEditorForm)).toHaveLength(0)
    expect(findAll(tree, PagesList)).toHaveLength(1)
  })

  it('an org admin of the active organisation gets the chooser editor with a link back to the pages', async () => {
    getCurrentUser.mockResolvedValue(owner([ORG]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({ page: 'chooser' }) })
    expect(db.tables).toContain('chooser_settings')
    expect(findAll(tree, ChooserEditorForm)).toHaveLength(1)
    expect(findAll(tree, PagesList)).toHaveLength(0)
    expect(linkHrefs(tree)).toContain('/settings/landing-page')
  })

  it('?location_id opens the legacy studio editor with a link back to the pages', async () => {
    getCurrentUser.mockResolvedValue(owner([]))
    const tree = await LandingPageSettingsPage({ searchParams: Promise.resolve({ location_id: LOC }) })
    const [form] = findAll(tree, LandingPageSettingsForm)
    expect(form.props).toMatchObject({ locationId: LOC, publicPath: 'x' })
    expect(findAll(tree, PagesList)).toHaveLength(0)
    expect(listPagesForUser).not.toHaveBeenCalled()
    expect(linkHrefs(tree)).toContain('/settings/landing-page')
  })
})
