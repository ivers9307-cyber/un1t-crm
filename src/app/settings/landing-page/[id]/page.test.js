// /settings/landing-page/<id> — the page editor (PAGES.1). An unknown id, a
// non-uuid and a page outside canViewPage are all a 404; a viewer who may not
// edit gets the form read-only and never a studio row's offer or attribution.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Hatch Street', shortName: 'UN1T', logoUrl: null })),
}))
vi.mock('@/lib/host-brand', () => ({
  resolveOrgChrome: vi.fn(async () => ({ orgId: 'org-1', companyName: 'UN1T Group', shortName: 'UN1T', legalName: 'x', studios: [] })),
}))
vi.mock('@/lib/landing-pages', async (importOriginal) => ({
  ...(await importOriginal()),
  loadPageById: vi.fn(),
  canViewPage: vi.fn(() => true),
  canEditPage: vi.fn(() => true),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/components/LandingPageSettingsForm', () => ({ default: () => null }))

import LandingPageEditorPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { resolveOrgChrome } from '@/lib/host-brand'
import { loadPageById, canViewPage, canEditPage, PageReadError } from '@/lib/landing-pages'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import { logError } from '@/lib/log'

const ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const LOC = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER = { id: 'u1', role: 'owner', locations: [{ id: LOC, organization_id: 'org-1' }] }

const page = (over = {}) => ({
  id: ID, organization_id: 'org-1', slug: 'summer', title: 'Summer', kind: 'campaign', scope: 'one',
  primary_location_id: LOC, offer_type: 'paid_trial', blocks: [], chrome: {}, publish_state: 'draft',
  redirect_to: null, updated_at: '2026-10-30T10:00:00Z', ...over,
})
const STUDIO_ROWS = [{
  page_id: ID, location_id: LOC, enabled: true, sort_order: 0,
  offer: { plan_code: 'TRIAL' }, attribution: { tag: 'summer' },
  locations: { id: LOC, name: 'UN1T Hatch Street', membership_source: 'glofox', settings: { secret: 'x' } },
}]

function makeDb() {
  const reads = []
  const from = (table) => {
    const chain = {
      select: () => chain, order: () => chain,
      eq: (col, val) => { reads.push([table, col, val]); return chain },
      then: (res) => Promise.resolve({ data: table === 'event_types' ? [{ id: 'et', name: 'Trial', slug: 'trial' }] : [], error: null }).then(res),
    }
    return chain
  }
  return { reads, from }
}

function findAll(node, type, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, type, out); return out }
  if (node.type === type) out.push(node)
  findAll(node.props?.children, type, out)
  return out
}

// The text and the link targets of a returned server-component tree.
function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
function hrefsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => hrefsOf(n, out)); return out }
  if (node.props?.href) out.push(node.props.href)
  hrefsOf(node.props?.children, out)
  return out
}

const open = (id = ID) => LandingPageEditorPage({ params: Promise.resolve({ id }) })

describe('/settings/landing-page/<id>', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(USER)
    hasPermission.mockReturnValue(true)
    loadPageById.mockReset().mockResolvedValue({ page: page(), studios: STUDIO_ROWS })
    canViewPage.mockReset().mockReturnValue(true)
    canEditPage.mockReset().mockReturnValue(true)
  })

  it('sends a signed-out caller to /login and one without landing_page home', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(open()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
    getCurrentUser.mockResolvedValue(USER)
    hasPermission.mockReturnValue(false)
    await expect(open()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('an unknown id, a non-uuid and a page the caller cannot view are all not found', async () => {
    loadPageById.mockResolvedValue(null)
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(open('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(loadPageById).toHaveBeenCalledTimes(1)
    loadPageById.mockResolvedValue({ page: page(), studios: STUDIO_ROWS })
    canViewPage.mockReturnValue(false)
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('an editor gets the page, its studio rows with offer and attribution, and the studio lists', async () => {
    const tree = await open()
    const [form] = findAll(tree, LandingPageSettingsForm)
    expect(form.props.canEdit).toBe(true)
    expect(form.props.page).toMatchObject({ id: ID, slug: 'summer' })
    expect(form.props.studios).toEqual([{
      location_id: LOC, name: 'UN1T Hatch Street', membership_source: 'glofox', enabled: true, sort_order: 0,
      offer: { plan_code: 'TRIAL' }, attribution: { tag: 'summer' },
    }])
    expect(form.props.availableBookingTypes).toEqual([{ id: 'et', name: 'Trial', slug: 'trial' }])
    expect(form.props.brand).toEqual({ companyName: 'UN1T Hatch Street', shortName: 'UN1T' })
    expect(db.reads).toContainEqual(['event_types', 'location_id', LOC])
    expect(hrefsOf(tree)).toContain('/settings/landing-page')
    expect(JSON.stringify(form.props)).not.toContain('secret')
  })

  it('a viewer without edit gets canEdit false and no offer on studios', async () => {
    canEditPage.mockReturnValue(false)
    const tree = await open()
    const [form] = findAll(tree, LandingPageSettingsForm)
    expect(form.props.canEdit).toBe(false)
    expect(form.props.studios[0]).not.toHaveProperty('offer')
    expect(form.props.studios[0]).not.toHaveProperty('attribution')
  })

  it('an all-studios page reads no studio lists and takes the organisation brand', async () => {
    loadPageById.mockResolvedValue({ page: page({ scope: 'all', primary_location_id: null }), studios: STUDIO_ROWS })
    const tree = await open()
    const [form] = findAll(tree, LandingPageSettingsForm)
    expect(form.props.availableBookingTypes).toEqual([])
    expect(form.props.availableEvents).toEqual([])
    expect(form.props.brand).toEqual({ companyName: 'UN1T Group', shortName: 'UN1T' })
    expect(resolveOrgChrome).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }))
    expect(db.reads).toHaveLength(0)
  })

  it('a studio page carries the banner that visitors still see its earlier content', async () => {
    loadPageById.mockResolvedValue({ page: page({ kind: 'studio', slug: 'hatch-street' }), studios: STUDIO_ROWS })
    const tree = await open()
    expect(textOf(tree)).toContain("Visitors see this studio page's earlier content until studio pages move to this editor.")
    expect(findAll(tree, LandingPageSettingsForm)).toHaveLength(1)
  })

  it('an unreadable page shows a message, never an editor', async () => {
    loadPageById.mockRejectedValue(new PageReadError('down'))
    const tree = await open()
    expect(findAll(tree, LandingPageSettingsForm)).toHaveLength(0)
    expect(textOf(tree)).toContain('could not be loaded')
    expect(logError).toHaveBeenCalledWith('landing-page-settings', 'page unreadable', expect.objectContaining({ pageId: ID }))
  })
})
