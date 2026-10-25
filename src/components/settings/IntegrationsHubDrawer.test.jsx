// @vitest-environment jsdom
//
// INTEGONE.1 — the hub's Manage drawer hosts each card's FULL per-location
// tab. It reads its context from GET /api/integrations/hub/locations/[id] and
// hands every hosted component exactly the props the retired per-location
// Integrations tab gave it, with the role answers taken from the server's
// `viewer` flags. A failed read renders no tab (only Try again), and there is
// no link back out to the old per-location page. The hosted components are stubbed: each has its own tests.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const seen = vi.hoisted(() => ({}))
function stub(name) {
  return {
    default: (props) => {
      seen[name] = props
      return <div data-testid={`hosted-${name}`}>{name}</div>
    },
  }
}
vi.mock('./integrations/GlofoxIntegrationTab', () => stub('glofox'))
vi.mock('./integrations/Un1tOnlineIntegrationTab', () => stub('un1t-online'))
vi.mock('./integrations/PaymentsIntegrationTab', () => stub('payments'))
vi.mock('./integrations/XeroIntegrationTab', () => stub('xero'))
vi.mock('./integrations/WhatsAppIntegrationTab', () => stub('whatsapp'))
vi.mock('./integrations/UnifiIntegrationTab', () => stub('unifi'))
vi.mock('./integrations/AcDevicesIntegrationTab', () => stub('climate'))
vi.mock('./integrations/BcaIntegrationTab', () => stub('bca'))
vi.mock('./integrations/AdsIntegrationTab', () => stub('ads'))
vi.mock('./MembershipSourceCard', () => stub('membership-source'))
vi.mock('@/components/customer-agent/ConnectionsSection', () => stub('instagram'))
vi.mock('./whatsapp/OrgWhatsAppNumbers', () => stub('whatsapp-numbers'))

import IntegrationsHubDrawer from './IntegrationsHubDrawer.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const LOCATION = { id: LOC, name: 'Stillorgan', organization_id: 'org-1', features: {}, membership_source: 'glofox', has_sensibo_key: true, has_thinq_pat: false }
const OWNER = { isMaster: false, isOwnerOrMaster: true, ownsWhatsAppHere: true, canSwitchWhatsApp: true, canManageNumbers: false }
const MASTER = { isMaster: true, isOwnerOrMaster: true, ownsWhatsAppHere: true, canSwitchWhatsApp: true, canManageNumbers: true }

const CONTEXT = (over = {}) => ({
  location: LOCATION,
  xeroConnection: { location_id: LOC, tenant_id: 't-1', tenant_name: 'Champ Fitness Ltd' },
  xeroReadFailed: false,
  sampleBcaCar: { uk_reg: 'AB12 CDE' },
  membershipSource: { source: 'glofox', state: 'configured' },
  hasUn1tOnlineConnection: false,
  viewer: OWNER,
  ...over,
})

function respond(...answers) {
  const queue = [...answers]
  global.fetch = vi.fn(async () => {
    const a = queue.length > 1 ? queue.shift() : queue[0]
    if (a instanceof Error) throw a
    return { ok: a.status === 200, status: a.status, json: async () => a.body }
  })
}
const ok = (data) => ({ status: 200, body: { success: true, data } })

function open(cardKey, props = {}) {
  return render(
    <IntegrationsHubDrawer cardKey={cardKey} locationId={LOC} locationName="Stillorgan"
      onClose={props.onClose || (() => {})} onChanged={props.onChanged || (() => {})} refreshKey={props.refreshKey || 0} />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete global.fetch
  for (const k of Object.keys(seen)) delete seen[k]
})

describe('IntegrationsHubDrawer — hosting (INTEGONE.1)', () => {
  it('fetches the location context and mounts the Glofox tab with canEdit = isOwnerOrMaster', async () => {
    respond(ok(CONTEXT()))
    open('glofox')
    expect(screen.getByRole('status').textContent).toMatch(/Loading Glofox settings/)
    await screen.findByTestId('hosted-glofox')
    expect(global.fetch).toHaveBeenCalledWith(`/api/integrations/hub/locations/${LOC}`, expect.objectContaining({ cache: 'no-store' }))
    expect(seen.glofox).toEqual({ location: LOCATION, canEdit: true })
  })

  it('xero: the connection, the read-failed flag, no second callback notice, a retry, and a return to the hub drawer', async () => {
    respond(ok(CONTEXT({ xeroConnection: null, xeroReadFailed: true })))
    open('xero')
    await screen.findByTestId('hosted-xero')
    expect(seen.xero).toMatchObject({
      location: LOCATION,
      connection: null,
      readFailed: true,
      showCallbackNotice: false,
      returnTo: `/settings/integrations-hub?manage=xero&location=${LOC}`,
    })
    expect(typeof seen.xero.onRetry).toBe('function')
  })

  it('whatsapp: the viewer flags become canEdit / canManageNumbers / canSwitch, with onChanged wired', async () => {
    const onChanged = vi.fn()
    respond(ok(CONTEXT({ viewer: { ...OWNER, canManageNumbers: true, canSwitchWhatsApp: false } })))
    open('whatsapp', { onChanged })
    await screen.findByTestId('hosted-whatsapp')
    expect(seen.whatsapp).toMatchObject({ location: LOCATION, canEdit: true, canManageNumbers: true, canSwitch: false })
    // A hosted save notifies the hub and re-reads the context.
    await act(async () => { seen.whatsapp.onChanged() })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('whatsapp switched off at the location (feature false, not a master): no tab', async () => {
    respond(ok(CONTEXT({ location: { ...LOCATION, features: { whatsapp: false } } })))
    open('whatsapp')
    expect(await screen.findByText('WhatsApp is switched off for this location.')).toBeTruthy()
    expect(screen.queryByTestId('hosted-whatsapp')).toBeNull()
  })

  it('whatsapp switched off at the location: a master still gets the tab (first-time setup, WA-MULTI.1)', async () => {
    respond(ok(CONTEXT({ location: { ...LOCATION, features: { whatsapp: false } }, viewer: MASTER })))
    open('whatsapp')
    await screen.findByTestId('hosted-whatsapp')
    expect(seen.whatsapp).toMatchObject({ canEdit: true, canManageNumbers: true, canSwitch: true })
  })

  it('whatsapp: a viewer who does not own WhatsApp here gets no tab (WAROLE.1)', async () => {
    respond(ok(CONTEXT({ viewer: { ...OWNER, ownsWhatsAppHere: false } })))
    open('whatsapp')
    expect(await screen.findByText('WhatsApp is switched off for this location.')).toBeTruthy()
    expect(screen.queryByTestId('hosted-whatsapp')).toBeNull()
  })

  it('bca: the sample car, and canEdit for masters only', async () => {
    respond(ok(CONTEXT()))
    open('bca')
    await screen.findByTestId('hosted-bca')
    expect(seen.bca).toEqual({ location: LOCATION, canEdit: false, sampleCar: { uk_reg: 'AB12 CDE' } })
    cleanup()
    respond(ok(CONTEXT({ viewer: MASTER })))
    open('bca')
    await screen.findByTestId('hosted-bca')
    expect(seen.bca.canEdit).toBe(true)
  })

  it('climate: the AC tab with canEdit = owner/master and canManage = master', async () => {
    respond(ok(CONTEXT()))
    open('climate')
    await screen.findByTestId('hosted-climate')
    expect(seen.climate).toEqual({ location: LOCATION, canEdit: true, canManage: false })
  })

  it('unifi, payments and membership-source get their props', async () => {
    respond(ok(CONTEXT({ viewer: MASTER })))
    open('unifi')
    await screen.findByTestId('hosted-unifi')
    expect(seen.unifi).toEqual({ location: LOCATION, canEdit: true })
    cleanup()
    respond(ok(CONTEXT()))
    open('payments')
    await screen.findByTestId('hosted-payments')
    expect(seen.payments).toEqual({ location: LOCATION, canEdit: true })
    cleanup()
    respond(ok(CONTEXT()))
    open('membership-source')
    await screen.findByTestId('hosted-membership-source')
    expect(seen['membership-source']).toEqual({ locationId: LOC, membershipSource: { source: 'glofox', state: 'configured' }, canEdit: true })
  })

  it('un1t.online keeps the offer rule: not at a Glofox studio without a token; yes with one', async () => {
    respond(ok(CONTEXT()))
    open('un1t-online')
    expect(await screen.findByText(/un1t.online is not offered here/)).toBeTruthy()
    expect(screen.queryByTestId('hosted-un1t-online')).toBeNull()
    cleanup()
    respond(ok(CONTEXT({ hasUn1tOnlineConnection: true })))
    open('un1t-online')
    await screen.findByTestId('hosted-un1t-online')
    expect(seen['un1t-online']).toEqual({ location: LOCATION, canEdit: true })
    cleanup()
    respond(ok(CONTEXT({ location: { ...LOCATION, membership_source: 'none' } })))
    open('un1t-online')
    await screen.findByTestId('hosted-un1t-online')
    cleanup()
    // A studio already on un1t.online (ported from the retired tab's tests).
    respond(ok(CONTEXT({ location: { ...LOCATION, membership_source: 'un1t_online' } })))
    open('un1t-online')
    await screen.findByTestId('hosted-un1t-online')
  })

  it('ads and instagram host as before, with no context read', async () => {
    respond(ok(CONTEXT()))
    open('ads')
    expect(screen.getByTestId('hosted-ads')).toBeTruthy()
    expect(seen.ads).toMatchObject({ location: { id: LOC, name: 'Stillorgan' }, canEdit: true })
    cleanup()
    open('instagram')
    expect(screen.getByTestId('hosted-instagram')).toBeTruthy()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('has no link back out to the old per-location tab', async () => {
    respond(ok(CONTEXT()))
    open('glofox')
    await screen.findByTestId('hosted-glofox')
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.body.innerHTML).not.toContain('/settings/locations/')
  })
})

describe('IntegrationsHubDrawer — a failed context read', () => {
  it('renders no tab, only Try again; a retry that succeeds mounts the tab', async () => {
    respond({ status: 500, body: { success: false } }, ok(CONTEXT()))
    open('glofox')
    expect(await screen.findByText(/Could not load Glofox for Stillorgan just now/)).toBeTruthy()
    expect(screen.queryByTestId('hosted-glofox')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    expect(await screen.findByTestId('hosted-glofox')).toBeTruthy()
  })

  it('a network failure is the same note; a retry that fails again says so', async () => {
    respond(new Error('offline'))
    open('xero')
    await screen.findByText(/Could not load Xero for Stillorgan just now/)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    expect(screen.getByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(screen.queryByTestId('hosted-xero')).toBeNull()
  })

  it('a 404 says the location is managed by its owner or a master, and offers nothing', async () => {
    respond({ status: 404, body: { success: false, error: 'Not found' } })
    open('payments')
    expect(await screen.findByText(/is managed by an owner at that location or a master/)).toBeTruthy()
    expect(screen.queryByTestId('hosted-payments')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('IntegrationsHubDrawer — refresh and accessibility', () => {
  it('a new refreshKey (the hub page re-rendered) re-reads the context quietly, keeping the tab mounted', async () => {
    respond(ok(CONTEXT()), ok(CONTEXT({ membershipSource: { source: 'glofox', state: 'unconfigured', missing: ['api_key'] } })))
    const { rerender } = open('membership-source')
    await screen.findByTestId('hosted-membership-source')
    rerender(
      <IntegrationsHubDrawer cardKey="membership-source" locationId={LOC} locationName="Stillorgan" onClose={() => {}} onChanged={() => {}} refreshKey={1} />,
    )
    expect(screen.getByTestId('hosted-membership-source')).toBeTruthy()
    await act(async () => {})
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(seen['membership-source'].membershipSource.state).toBe('unconfigured')
  })

  it('a failed quiet re-read keeps the last good context', async () => {
    respond(ok(CONTEXT()), { status: 500, body: { success: false } })
    const { rerender } = open('glofox')
    await screen.findByTestId('hosted-glofox')
    rerender(<IntegrationsHubDrawer cardKey="glofox" locationId={LOC} locationName="Stillorgan" onClose={() => {}} onChanged={() => {}} refreshKey={1} />)
    await act(async () => {})
    expect(screen.getByTestId('hosted-glofox')).toBeTruthy()
    expect(screen.queryByText(/Could not load/)).toBeNull()
  })

  it('is a modal dialog that closes on Escape and from the close button', async () => {
    respond(ok(CONTEXT()))
    const onClose = vi.fn()
    open('glofox', { onClose })
    const dialog = screen.getByRole('dialog', { name: 'Manage Glofox' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    await screen.findByTestId('hosted-glofox')
  })
})

// INTEGONE.3 — the organisation's WhatsApp numbers: org-level, so no location
// context is read; the hub hands the drawer the organisation it administers.
describe('IntegrationsHubDrawer — whatsapp-numbers (INTEGONE.3)', () => {
  const ORG = { id: 'org-1', name: 'UN1T Group', locations: [{ id: LOC, name: 'Stillorgan' }] }

  it('makes no context fetch and mounts OrgWhatsAppNumbers with the organisation', () => {
    global.fetch = vi.fn()
    render(<IntegrationsHubDrawer cardKey="whatsapp-numbers" organization={ORG} onClose={() => {}} onChanged={() => {}} />)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('hosted-whatsapp-numbers')).toBeTruthy()
    expect(seen['whatsapp-numbers']).toEqual({
      organizationId: 'org-1',
      organizationName: 'UN1T Group',
      locations: [{ id: LOC, name: 'Stillorgan' }],
    })
    // No loading spinner, and the header names the tab and the organisation.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toMatch(/Manage WhatsApp numbers/)
    expect(screen.getByRole('dialog').textContent).toMatch(/UN1T Group/)
  })

  it('mounts nothing for an organisation the viewer does not administer', () => {
    global.fetch = vi.fn()
    render(<IntegrationsHubDrawer cardKey="whatsapp-numbers" organization={null} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.queryByTestId('hosted-whatsapp-numbers')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
