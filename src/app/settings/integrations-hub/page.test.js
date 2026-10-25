// HUBREAD.1 — the hub page's own locations read. A failure used to hand []
// to the assembler: no locations, every card empty with Connect buttons,
// and "All connections healthy".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getOwnerOrganizationIds: vi.fn(() => ['org-1']),
  assertOrganizationAccess: vi.fn(() => null),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/integrations-hub', () => ({ assembleIntegrationsHub: vi.fn(async () => ({ stub: true })) }))
vi.mock('@/components/settings/IntegrationsHub', () => ({
  default: ({ view, viewPanel, managedOrgs, showZoom }) => (
    <div data-view={view || 'overview'} data-zoom={String(!!showZoom)} data-orgs={JSON.stringify(managedOrgs || [])}>
      HUB_RENDERED{viewPanel}
    </div>
  ),
}))
vi.mock('@/lib/integration-health', () => ({
  getIntegrationHealth: vi.fn(async () => [{ key: 'crons', name: 'Scheduled jobs', status: 'ok', detail: 'fine' }]),
  worstStatus: vi.fn(() => 'ok'),
}))
vi.mock('@/components/settings/ZoomContactsPanel', () => ({ default: () => <p>ZOOM_PANEL</p> }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import IntegrationsHubPage, { pickHealthLocation } from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import { logError } from '@/lib/log'
import { getIntegrationHealth } from '@/lib/integration-health'
import { assertOrganizationAccess } from '@/lib/auth'

function locationsDb(result) {
  const b = {
    select: () => b, eq: () => b, order: () => b, in: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return { from: () => b }
}

// A db whose tables answer differently (locations vs organizations).
function tablesDb(byTable) {
  return {
    from: (t) => {
      const b = {
        select: () => b, eq: () => b, order: () => b, in: () => b,
        then: (res, rej) => Promise.resolve(byTable[t] || { data: [], error: null }).then(res, rej),
      }
      return b
    },
  }
}
const render = async (searchParams = {}) =>
  renderToStaticMarkup(await IntegrationsHubPage({ searchParams: Promise.resolve(searchParams) }))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ZOOM_SYNC_ORGANIZATION_ID
  getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
})

describe('/settings/integrations-hub — the locations read (HUBREAD.1)', () => {
  it('a failed read says it could not load, and never renders an empty hub', async () => {
    createServerClient.mockReturnValue(locationsDb({ data: null, error: { message: 'db exploded' } }))
    const html = renderToStaticMarkup(await IntegrationsHubPage())
    expect(html).toContain('Could not load your locations just now')
    expect(html).not.toContain('HUB_RENDERED')
    expect(html).not.toContain('db exploded')
    expect(assembleIntegrationsHub).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a good read still renders the hub (pin)', async () => {
    createServerClient.mockReturnValue(locationsDb({ data: [{ id: 'loc-a', name: 'Stillorgan' }], error: null }))
    const html = renderToStaticMarkup(await IntegrationsHubPage())
    expect(html).toContain('HUB_RENDERED')
    expect(assembleIntegrationsHub).toHaveBeenCalledTimes(1)
  })
})

// C141 ORGROLE.2 — the page passes the same billingFor rule as the route.
describe('/settings/integrations-hub — plan & wallet strip is organisation-admin only (C141)', () => {
  it('an owner without an org_admin grant: billingFor admits nothing', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'u2', isMaster: false, role: 'owner', orgAdminOrgIds: [],
      activeOrganization: { id: 'org-1' },
    })
    createServerClient.mockReturnValue(locationsDb({ data: [{ id: 'loc-a', name: 'A', organization_id: 'org-1' }], error: null }))
    await IntegrationsHubPage()
    const { billingFor } = assembleIntegrationsHub.mock.calls[0][2]
    expect(billingFor({ id: 'loc-a', organization_id: 'org-1' })).toBe(false)
  })

  it('an org admin: billingFor admits their organisation\'s locations', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'u3', isMaster: false, role: 'owner', orgAdminOrgIds: ['org-1'],
      activeOrganization: { id: 'org-1' },
    })
    createServerClient.mockReturnValue(locationsDb({ data: [{ id: 'loc-a', name: 'A', organization_id: 'org-1' }], error: null }))
    await IntegrationsHubPage()
    const { billingFor } = assembleIntegrationsHub.mock.calls[0][2]
    expect(billingFor({ id: 'loc-a', organization_id: 'org-1' })).toBe(true)
    expect(billingFor({ id: 'loc-x', organization_id: 'org-2' })).toBe(false)
  })
})

const LOCS = [
  { id: 'loc-a', name: 'Stillorgan', organization_id: 'org-1', active: true },
  { id: 'loc-b', name: 'Hatch Street', organization_id: 'org-1', active: true },
]

// INTEGONE.3 — ?view=health: the studio is always one of the LOADED locations.
describe('/settings/integrations-hub?view=health (INTEGONE.3)', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u2', isMaster: false, role: 'owner', orgAdminOrgIds: [], activeLocation: { id: 'loc-b' } })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: LOCS, error: null } }))
  })

  it('grades the requested studio when it is in scope, and skips the cards assembly', async () => {
    const html = await render({ view: 'health', location: 'loc-a' })
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
    expect(getIntegrationHealth.mock.calls[0][1]).toBe('loc-a')
    expect(html).toContain('data-view="health"')
    expect(html).toContain('Stillorgan')
    expect(html).toContain('Scheduled jobs')
    expect(assembleIntegrationsHub).not.toHaveBeenCalled()
  })

  it('falls back to the active location when none is requested', async () => {
    await render({ view: 'health' })
    expect(getIntegrationHealth.mock.calls[0][1]).toBe('loc-b')
  })

  it('NEVER runs health for a location outside the loaded list (falls back to the active one)', async () => {
    await render({ view: 'health', location: 'loc-other-tenant' })
    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
    expect(getIntegrationHealth.mock.calls[0][1]).toBe('loc-b')
  })

  it('an active location outside the list falls back to the first; an empty list runs nothing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', isMaster: false, role: 'owner', orgAdminOrgIds: [], activeLocation: { id: 'elsewhere' } })
    await render({ view: 'health' })
    expect(getIntegrationHealth.mock.calls[0][1]).toBe('loc-a')
    getIntegrationHealth.mockClear()
    createServerClient.mockReturnValue(tablesDb({ locations: { data: [], error: null } }))
    await render({ view: 'health' })
    expect(getIntegrationHealth).not.toHaveBeenCalled()
  })

  it('pickHealthLocation is pure: requested, else active, else first', () => {
    expect(pickHealthLocation(LOCS, 'loc-a', 'loc-b').id).toBe('loc-a')
    expect(pickHealthLocation(LOCS, 'nope', 'loc-b').id).toBe('loc-b')
    expect(pickHealthLocation(LOCS, null, null).id).toBe('loc-a')
    expect(pickHealthLocation([], 'loc-a', 'loc-b')).toBeNull()
  })

  it('a failed locations read still shows the unavailable note, not a health view', async () => {
    createServerClient.mockReturnValue(tablesDb({ locations: { data: null, error: { message: 'x' } } }))
    const html = await render({ view: 'health' })
    expect(html).toContain('Could not load your locations just now')
    expect(getIntegrationHealth).not.toHaveBeenCalled()
  })
})

describe('/settings/integrations-hub?view=zoom (INTEGONE.3)', () => {
  it('renders the Zoom panel inside the hub shell, with no cards assembly', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: LOCS, error: null } }))
    const html = await render({ view: 'zoom' })
    expect(html).toContain('data-view="zoom"')
    expect(html).toContain('ZOOM_PANEL')
    expect(assembleIntegrationsHub).not.toHaveBeenCalled()
  })

  it('an unknown view is the overview', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: LOCS, error: null } }))
    const html = await render({ view: 'bogus' })
    expect(html).toContain('data-view="overview"')
    expect(assembleIntegrationsHub).toHaveBeenCalledTimes(1)
  })

  it('showZoom: a master always; an owner only when a member of the synced organisation', async () => {
    createServerClient.mockReturnValue(tablesDb({ locations: { data: LOCS, error: null } }))
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
    expect(await render()).toContain('data-zoom="true"')

    getCurrentUser.mockResolvedValue({ id: 'u2', isMaster: false, role: 'owner', orgAdminOrgIds: [] })
    expect(await render()).toContain('data-zoom="false"') // no ZOOM_SYNC_ORGANIZATION_ID

    process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-1'
    assertOrganizationAccess.mockReturnValue({ status: 403 })
    expect(await render()).toContain('data-zoom="false"')
    assertOrganizationAccess.mockReturnValue(null)
    expect(await render()).toContain('data-zoom="true"')
  })
})

// INTEGONE.3 — managedOrgs: only organisations the viewer ADMINISTERS.
describe('/settings/integrations-hub — managedOrgs (INTEGONE.3)', () => {
  const managed = (html) => JSON.parse(html.match(/data-orgs="([^"]*)"/)[1].replace(/&quot;/g, '"'))
  const MULTI = [
    ...LOCS,
    { id: 'loc-c', name: 'CCF', organization_id: 'org-2', active: true },
    { id: 'loc-d', name: 'Closed', organization_id: 'org-1', active: false },
  ]
  const ORGS = { data: [{ id: 'org-1', name: 'UN1T Group' }, { id: 'org-2', name: 'CCF Autos' }], error: null }

  it('an owner who is not an org admin has none, and no organisations read happens', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', isMaster: false, role: 'owner', orgAdminOrgIds: [] })
    const from = vi.fn()
    createServerClient.mockReturnValue({ from: (t) => { from(t); return tablesDb({ locations: { data: MULTI, error: null } }).from(t) } })
    expect(managed(await render())).toEqual([])
    expect(from).not.toHaveBeenCalledWith('organizations')
  })

  it('an org admin of org-1 gets org-1 only, named, with its ACTIVE studios', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u3', isMaster: false, role: 'owner', orgAdminOrgIds: ['org-1'] })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: MULTI, error: null }, organizations: ORGS }))
    expect(managed(await render())).toEqual([
      { id: 'org-1', name: 'UN1T Group', locations: [{ id: 'loc-a', name: 'Stillorgan' }, { id: 'loc-b', name: 'Hatch Street' }] },
    ])
  })

  it('a master gets every organisation among the loaded locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: MULTI, error: null }, organizations: ORGS }))
    expect(managed(await render()).map((o) => o.id)).toEqual(['org-1', 'org-2'])
  })

  it('a failed organisations read gives none, logs it, and the hub still renders', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
    createServerClient.mockReturnValue(tablesDb({ locations: { data: MULTI, error: null }, organizations: { data: null, error: { message: 'boom' } } }))
    const html = await render()
    expect(managed(html)).toEqual([])
    expect(html).toContain('HUB_RENDERED')
    expect(logError).toHaveBeenCalledTimes(1)
  })
})
