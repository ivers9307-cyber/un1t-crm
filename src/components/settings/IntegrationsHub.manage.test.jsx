// @vitest-environment jsdom
//
// INTEGONE.1 — the hub opens a card's Manage drawer from the URL
// (?manage=<cardKey>&location=<id>) when that card is on screen for the
// viewer, ignores it otherwise, and clears the two params on close. The two
// new cards (Membership source, Payments) grade their chips from the
// assembler's rows and open their drawers.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

const nav = vi.hoisted(() => ({ params: '', replace: null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.params),
  usePathname: () => '/settings/integrations-hub',
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, className, ...rest }) => <a href={typeof href === 'string' ? href : ''} className={className} {...rest}>{children}</a>,
}))
const drawer = vi.hoisted(() => ({ props: null }))
vi.mock('./IntegrationsHubDrawer', () => ({
  default: (props) => {
    drawer.props = props
    return (
      <div data-testid="drawer" data-card={props.cardKey} data-location={props.locationId} data-org={props.organization?.id}>
        <button type="button" onClick={props.onClose}>close drawer</button>
      </div>
    )
  },
}))

import IntegrationsHub, { canOpenFromUrl, pickManagedOrg } from './IntegrationsHub'
import { membershipSettingsHref } from '@/lib/membership/state-for-page'
import { legacyIntegrationsTabRedirect } from '@/lib/integrations-hub-links'

const A = { id: 'loc-a', name: 'Stillorgan' }
const B = { id: 'loc-b', name: 'Hatch Street' }
const ORG1 = { id: 'org-1', name: 'UN1T Group', locations: [A, B] }
const ORG2 = { id: 'org-2', name: 'CCF Autos', locations: [] }
const BASE = {
  generatedAt: '2026-10-25T09:00:00Z',
  expirySoonDays: 10,
  locations: [A, B],
  glofox: [{ locationId: A.id, status: 'connected', branchId: 'br-123456789' }],
  un1t_online: [{ locationId: B.id, status: 'connected', studioTitle: 'Hatch Street' }],
  membershipSource: [
    { locationId: A.id, status: 'connected', source: 'glofox', state: 'configured', missing: [] },
    { locationId: B.id, status: 'action_needed', source: 'un1t_online', state: 'unconfigured', missing: ['api_token'] },
  ],
  payments: [
    { locationId: A.id, provider: 'revolut', hasStripeAccount: false, status: 'connected' },
    { locationId: B.id, provider: 'stripe_connect', hasStripeAccount: false, status: 'not_connected' },
  ],
  whatsapp: [], instagram: [], xero: [], ads: [], shelly: [], agent: [], email: [],
  unifi: [{ locationId: A.id, status: 'connected' }], climate: [], bca: [], billing: [], attention: [],
}

beforeEach(() => { nav.params = ''; nav.replace = vi.fn(); drawer.props = null })
afterEach(() => { cleanup() })

describe('IntegrationsHub — ?manage= opens a drawer (INTEGONE.1)', () => {
  it('opens the named card\'s drawer for the named location on load', () => {
    nav.params = 'manage=payments&location=loc-b'
    render(<IntegrationsHub data={BASE} />)
    const d = screen.getByTestId('drawer')
    expect(d.dataset.card).toBe('payments')
    expect(d.dataset.location).toBe('loc-b')
    expect(drawer.props.locationName).toBe('Hatch Street')
  })

  it('closing clears manage + location and keeps every other param', () => {
    nav.params = 'manage=xero&location=loc-a&xero_connected=1'
    render(<IntegrationsHub data={BASE} />)
    fireEvent.click(screen.getByRole('button', { name: 'close drawer' }))
    expect(screen.queryByTestId('drawer')).toBeNull()
    expect(nav.replace).toHaveBeenCalledWith('/settings/integrations-hub?xero_connected=1', { scroll: false })
  })

  it('ignores a card the viewer cannot see (a master-tier card for an owner), an unknown location, and an unknown card', () => {
    for (const params of ['manage=unifi&location=loc-a', 'manage=glofox&location=loc-zzz', 'manage=bogus&location=loc-a', 'manage=glofox']) {
      nav.params = params
      render(<IntegrationsHub data={BASE} />)
      expect(screen.queryByTestId('drawer')).toBeNull()
      cleanup()
    }
    nav.params = 'manage=unifi&location=loc-a'
    render(<IntegrationsHub data={BASE} isMaster />)
    expect(screen.getByTestId('drawer').dataset.card).toBe('unifi')
  })

  it('a button opens a drawer without touching the URL; closing it then replaces nothing', () => {
    render(<IntegrationsHub data={BASE} />)
    const manage = screen.getAllByRole('button', { name: 'Manage' })
    fireEvent.click(manage[0]) // Membership source, Stillorgan (first card)
    expect(screen.getByTestId('drawer').dataset.card).toBe('membership-source')
    fireEvent.click(screen.getByRole('button', { name: 'close drawer' }))
    expect(nav.replace).not.toHaveBeenCalled()
  })
})

// INTEGONE.1 stage 2 — the URLs the retired per-location tab's producers now
// emit really open the drawer they name (this replaced the page test that
// pinned membershipSettingsHref landing on the old tab's Membership source card).
describe('IntegrationsHub — the repointed producers land on their drawer', () => {
  const openFrom = (href) => {
    const u = new URL(href, 'http://localhost')
    expect(u.pathname).toBe('/settings/integrations-hub')
    nav.params = u.searchParams.toString()
    render(<IntegrationsHub data={BASE} />)
    return screen.queryByTestId('drawer')
  }

  it('the membership-source gate link opens the Membership source drawer', () => {
    const d = openFrom(membershipSettingsHref('loc-a'))
    expect(d.dataset.card).toBe('membership-source')
    expect(d.dataset.location).toBe('loc-a')
  })

  it('an old ?section=integrations&tab=payments&stripe=return URL opens Payments and keeps stripe=return', () => {
    const href = legacyIntegrationsTabRedirect('loc-b', { section: 'integrations', tab: 'payments', stripe: 'return' })
    expect(new URL(href, 'http://localhost').searchParams.get('stripe')).toBe('return')
    expect(openFrom(href).dataset.card).toBe('payments')
  })

  it('a bare ?section=integrations opens nothing', () => {
    expect(openFrom(legacyIntegrationsTabRedirect('loc-a', { section: 'integrations' }))).toBeNull()
  })
})

describe('canOpenFromUrl', () => {
  it('per-row cards need a readable row for that location', () => {
    expect(canOpenFromUrl(BASE, false, 'glofox', 'loc-a')).toBe(true)
    expect(canOpenFromUrl(BASE, false, 'glofox', 'loc-b')).toBe(false)
    expect(canOpenFromUrl({ ...BASE, glofox: [{ locationId: 'loc-a', status: 'unknown' }] }, false, 'glofox', 'loc-a')).toBe(false)
    expect(canOpenFromUrl(BASE, false, 'un1t-online', 'loc-b')).toBe(true)
    expect(canOpenFromUrl({ ...BASE, un1t_online: [{ locationId: 'loc-b', status: 'not_connected' }] }, false, 'un1t-online', 'loc-b')).toBe(false)
    expect(canOpenFromUrl({ ...BASE, un1t_online: [{ locationId: 'loc-b', status: 'not_connected', offerConnect: true }] }, false, 'un1t-online', 'loc-b')).toBe(true)
  })

  it('Xero / Instagram / Ads open for any hub location unless the card is unreadable', () => {
    expect(canOpenFromUrl(BASE, false, 'xero', 'loc-b')).toBe(true)
    expect(canOpenFromUrl({ ...BASE, xero: [{ locationId: 'loc-a', status: 'unknown' }] }, false, 'xero', 'loc-b')).toBe(false)
  })

  it('the master tier needs a master', () => {
    expect(canOpenFromUrl(BASE, false, 'unifi', 'loc-a')).toBe(false)
    expect(canOpenFromUrl(BASE, true, 'unifi', 'loc-a')).toBe(true)
  })
})

describe('IntegrationsHub — Membership source and Payments cards', () => {
  it('Membership source comes first in tier 1 and grades the worst row', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={BASE} />)
    expect(html.indexOf('Membership source')).toBeLessThan(html.indexOf('>Glofox<'))
    expect(html).toContain('Glofox · configured')
    expect(html).toContain('un1t.online · missing api_token')
    // worst of configured + unconfigured = action needed
    expect(html).toMatch(/bg-amber-500\/10 text-amber-700[^>]*>.*?Action needed/)
  })

  it('Membership source: a none studio reads "None set"; an unreadable row offers Try again, not Manage', () => {
    const data = { ...BASE, locations: [A], membershipSource: [{ locationId: A.id, status: 'not_connected', source: 'none', state: 'none', missing: [] }] }
    const html = renderToStaticMarkup(<IntegrationsHub data={data} />)
    expect(html).toContain('None set')
    expect(html).toContain('None (lead CRM only)')
    const unread = { ...BASE, locations: [A], glofox: [], un1t_online: [], payments: [], membershipSource: [{ locationId: A.id, status: 'unknown', source: null, state: 'unknown', missing: [] }] }
    const html2 = renderToStaticMarkup(<IntegrationsHub data={unread} />)
    expect(html2).toContain('Could not load just now')
    expect(html2).toContain('Try again')
    expect(html2).not.toMatch(/>Manage</)
  })

  it('Payments: Revolut needs no setup; Stripe without an account is not connected', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={BASE} />)
    expect(html).toContain('Revolut · platform merchant, no setup needed')
    expect(html).toContain('Stripe Connect · onboarding not finished')
    const onlyRevolut = renderToStaticMarkup(<IntegrationsHub data={{ ...BASE, payments: [BASE.payments[0]] }} />)
    expect(onlyRevolut).toMatch(/>Payments<[\s\S]*?bg-green-500\/10 text-green-700/)
  })

  it('a payload without the two keys renders neither card', () => {
    const { membershipSource: _m, payments: _p, ...old } = BASE
    const html = renderToStaticMarkup(<IntegrationsHub data={old} />)
    expect(html).not.toContain('Membership source')
    expect(html).not.toContain('Class-funnel intro offer')
  })

  it('Payments Manage opens the payments drawer for that row', () => {
    render(<IntegrationsHub data={{ ...BASE, membershipSource: [] }} />)
    // Payments rows: Stillorgan, Hatch Street. Glofox has a Manage too, first.
    const buttons = screen.getAllByRole('button', { name: 'Manage' })
    fireEvent.click(buttons[buttons.length - 1])
    expect(screen.getByTestId('drawer').dataset.card).toBe('payments')
    expect(screen.getByTestId('drawer').dataset.location).toBe('loc-b')
  })
})

// INTEGONE.3 — the organisation numbers drawer: ?manage=whatsapp-numbers[&org=<id>].
describe('IntegrationsHub — organisation WhatsApp numbers (INTEGONE.3)', () => {
  it('?manage=whatsapp-numbers&org=<id> opens it for a managed organisation', () => {
    nav.params = 'manage=whatsapp-numbers&org=org-2'
    render(<IntegrationsHub data={BASE} managedOrgs={[ORG1, ORG2]} />)
    const d = screen.getByTestId('drawer')
    expect(d.dataset.card).toBe('whatsapp-numbers')
    expect(d.dataset.org).toBe('org-2')
    expect(drawer.props.organization).toEqual(ORG2)
  })

  it('without org it opens the only managed organisation, or the first of several', () => {
    nav.params = 'manage=whatsapp-numbers'
    render(<IntegrationsHub data={BASE} managedOrgs={[ORG1]} />)
    expect(screen.getByTestId('drawer').dataset.org).toBe('org-1')
    cleanup()
    render(<IntegrationsHub data={BASE} managedOrgs={[ORG2, ORG1]} />)
    expect(screen.getByTestId('drawer').dataset.org).toBe('org-2')
  })

  it('is ignored for an organisation the viewer does not administer, and when they administer none', () => {
    nav.params = 'manage=whatsapp-numbers&org=org-9'
    render(<IntegrationsHub data={BASE} managedOrgs={[ORG1]} />)
    expect(screen.queryByTestId('drawer')).toBeNull()
    cleanup()
    nav.params = 'manage=whatsapp-numbers'
    render(<IntegrationsHub data={BASE} managedOrgs={[]} />)
    expect(screen.queryByTestId('drawer')).toBeNull()
  })

  it('closing clears manage and org and keeps every other param', () => {
    nav.params = 'manage=whatsapp-numbers&org=org-1&xero_connected=1'
    render(<IntegrationsHub data={BASE} managedOrgs={[ORG1]} />)
    fireEvent.click(screen.getByRole('button', { name: 'close drawer' }))
    expect(screen.queryByTestId('drawer')).toBeNull()
    expect(nav.replace).toHaveBeenCalledWith('/settings/integrations-hub?xero_connected=1', { scroll: false })
  })

  it('the WhatsApp card carries one Organisation numbers button per managed organisation (named only when there are several)', () => {
    const data = { ...BASE, whatsapp: [{ locationId: A.id, status: 'connected', numbers: [], budget: null }] }
    render(<IntegrationsHub data={data} managedOrgs={[ORG1]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Organisation numbers' }))
    expect(screen.getByTestId('drawer').dataset.org).toBe('org-1')
    cleanup()
    render(<IntegrationsHub data={data} managedOrgs={[ORG1, ORG2]} />)
    expect(screen.getByRole('button', { name: 'Organisation numbers · UN1T Group' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Organisation numbers · CCF Autos' })).toBeTruthy()
    cleanup()
    render(<IntegrationsHub data={data} managedOrgs={[]} />)
    expect(screen.queryByRole('button', { name: /Organisation numbers/ })).toBeNull()
  })

  it('pickManagedOrg: named wins, none named takes the first, a stranger is null', () => {
    expect(pickManagedOrg([ORG1, ORG2], 'org-2')).toBe(ORG2)
    expect(pickManagedOrg([ORG1, ORG2], null)).toBe(ORG1)
    expect(pickManagedOrg([ORG1], 'org-x')).toBeNull()
    expect(pickManagedOrg([], null)).toBeNull()
  })
})

// INTEGONE.3 — the view switcher and the non-overview shell.
describe('IntegrationsHub — view switcher (INTEGONE.3)', () => {
  it('the overview shows Overview and Health (Zoom only when showZoom), the active view marked', () => {
    const { container } = render(<IntegrationsHub data={BASE} />)
    const nav1 = container.querySelector('nav[aria-label="Integrations views"]')
    const links = Array.from(nav1.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])
    expect(links).toEqual([
      ['Overview', '/settings/integrations-hub', 'page'],
      ['Health', '/settings/integrations-hub?view=health', null],
    ])
    cleanup()
    const r2 = render(<IntegrationsHub data={BASE} showZoom />)
    const hrefs = Array.from(r2.container.querySelectorAll('nav[aria-label="Integrations views"] a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/settings/integrations-hub?view=zoom')
  })

  it('a view renders the header, the switcher and the panel INSTEAD of the cards', () => {
    const { container } = render(
      <IntegrationsHub data={BASE} view="health" showZoom viewPanel={<p data-testid="panel">PANEL</p>} />,
    )
    expect(screen.getByTestId('panel')).toBeTruthy()
    expect(container.textContent).toContain('Integrations')
    expect(container.textContent).not.toContain('Status model')
    expect(container.textContent).not.toContain('Membership source')
    expect(container.querySelector('a[aria-current="page"]').textContent).toBe('Health')
    expect(container.querySelector('[aria-label="Location scope"]')).toBeNull()
  })
})
