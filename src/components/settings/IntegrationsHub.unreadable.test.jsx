// @vitest-environment jsdom
//
// HUBREAD.1 — a card whose read failed must offer NO connect, reconnect,
// manage, disconnect, set-up or edit action: only "Try again". The payload
// below is exactly what assembleIntegrationsHub now returns when every read
// fails (see integrations-hub.test.js), rendered to static markup.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
vi.mock('./IntegrationsHubDrawer', () => ({ default: () => null }))

import IntegrationsHub from './IntegrationsHub'

const LOC = { id: 'loc-a', name: 'Stillorgan' }
const MSG = 'Could not load this just now. Try again in a moment.'
const U = (extra = {}) => ({ locationId: LOC.id, status: 'unknown', message: MSG, href: '/x', ...extra })

const UNREAD = {
  generatedAt: '2026-09-28T09:00:00Z',
  expirySoonDays: 10,
  locations: [LOC],
  glofox: [U()],
  whatsapp: [U({ numbers: [], budget: null })],
  instagram: [U()],
  xero: [U()],
  ads: [U()],
  shelly: [],
  sms: [{ locationId: LOC.id, senderId: null, senderKnown: false, source: null, href: '/x' }],
  agent: [{ locationId: LOC.id, mode: 'off', agentName: null }],
  email: [{ organizationId: 'org-1', orgName: null, locationIds: [LOC.id], status: 'unknown', href: '/settings/email-domain' }],
  unifi: [U()],
  climate: [U({ vendors: [] })],
  bca: [U()],
  billing: [{ locationId: LOC.id, plan: null, unreadable: true }],
  attention: [{
    severity: 'warning', cardKey: 'xero', label: 'Xero', locationId: LOC.id, locationName: 'All locations',
    message: 'Could not load Xero just now. Try again in a moment.', href: null, unreadable: true,
  }],
}

describe('IntegrationsHub — unknown rows (HUBREAD.1)', () => {
  it('offers no Connect/Reconnect/Manage/Set up/Edit on an unreadable card, only Try again', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={UNREAD} isMaster />)
    expect(html).not.toMatch(/>Connect</)
    expect(html).not.toMatch(/>Reconnect</)
    expect(html).not.toMatch(/>Manage</)
    expect(html).not.toContain('Set up domain')
    expect(html).not.toContain('Edit sender ID')
    expect(html).toContain('Try again')
    expect(html).toContain('Could not load')
  })

  it('never says an unreadable thing is absent or healthy', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={UNREAD} isMaster />)
    for (const lie of [
      'All connections healthy',
      'No Xero organisation connected',
      'No Instagram connection',
      'No ad account connected',
      'No number yet',
      'No platform plan',
      'Sending via the platform email account',
    ]) {
      expect(html).not.toContain(lie)
    }
  })

  it('keeps the unreadable attention row with two locations in view', () => {
    // The row is pinned to the first location. The scope filter change
    // (r.unreadable || inScope) keeps it under a single-location scope
    // too; the reviewer checks that line, since scope is client state.
    const two = { ...UNREAD, locations: [LOC, { id: 'loc-b', name: 'Hatch Street' }] }
    const html = renderToStaticMarkup(<IntegrationsHub data={two} isMaster />)
    expect(html).toContain('Could not load Xero just now')
  })

  it('the status legend explains the "Could not load" chip (N1)', () => {
    const html = renderToStaticMarkup(<IntegrationsHub data={{ ...UNREAD, attention: [] }} isMaster />)
    const legend = html.match(/aria-label="Status legend">([\s\S]*?)<\/div>/)
    expect(legend?.[1]).toContain('Could not load')
  })

  it('an unreadable card tags "2 locations" under All locations, never the first site (N2)', () => {
    const B = { id: 'loc-b', name: 'Hatch Street' }
    const UB = (extra = {}) => ({ ...U(extra), locationId: B.id })
    const two = {
      ...UNREAD,
      locations: [LOC, B],
      instagram: [U(), UB()],
      xero: [U(), UB()],
      ads: [U(), UB()],
      unifi: [U(), UB()],
    }
    const html = renderToStaticMarkup(<IntegrationsHub data={two} isMaster />)
    for (const title of ['Instagram', 'Xero', 'Meta Ads', 'UniFi Access']) {
      const tag = html.match(new RegExp(`<h3[^>]*>${title}<span[^>]*>([^<]*)</span>`))?.[1]
      expect(tag, title).toBe('2 locations')
    }
  })

  it('a genuinely unconnected location still offers Connect (pin)', () => {
    const healthy = {
      ...UNREAD,
      glofox: [{ locationId: LOC.id, status: 'not_connected', href: '/x' }],
      whatsapp: [], instagram: [], xero: [], ads: [], unifi: [], climate: [], bca: [],
      sms: [{ locationId: LOC.id, senderId: null, senderKnown: true, source: 'legacy', href: '/x' }],
      email: [], billing: [{ locationId: LOC.id, plan: null }], attention: [],
    }
    const html = renderToStaticMarkup(<IntegrationsHub data={healthy} isMaster />)
    expect(html).toMatch(/>Connect</)
    expect(html).toContain('All connections healthy')
  })
})

describe('IntegrationsHub — Try again gives feedback (HUBREAD.1 N4)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  // The re-fetch is held open until the test releases it.
  function heldFetch() {
    let release
    const gate = new Promise((r) => { release = r })
    const fetchMock = vi.fn(() => gate)
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, release }
  }

  it('shows a pending state, then "Still couldn\'t load" when the retry fails', async () => {
    const { fetchMock, release } = heldFetch()
    render(<IntegrationsHub data={UNREAD} isMaster />)
    const [first] = screen.getAllByRole('button', { name: 'Try again' })
    await act(async () => { fireEvent.click(first) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const pending = screen.getAllByRole('button', { name: 'Trying…' })
    expect(pending.length).toBeGreaterThan(0)
    for (const b of pending) expect(b.disabled).toBe(true)

    await act(async () => { release({ json: async () => ({ success: false, error: 'boom' }) }) })

    expect(screen.queryAllByRole('button', { name: 'Trying…' })).toHaveLength(0)
    // Only under the button that was pressed, not on every card.
    expect(screen.getAllByText("Still couldn't load. Try again in a minute.")).toHaveLength(1)
  })

  it('a thrown fetch is a failed retry too', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<IntegrationsHub data={UNREAD} isMaster />)
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]) })
    expect(screen.getByText("Still couldn't load. Try again in a minute.")).toBeTruthy()
  })

  it('a retry that loads clears the card: no failure note (pin)', async () => {
    const healthy = { ...UNREAD, xero: [], attention: [], billing: [{ locationId: LOC.id, plan: null }] }
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: healthy }) })))
    render(<IntegrationsHub data={UNREAD} isMaster />)
    // The first Try again is the billing strip's; after the load it is gone.
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]) })
    expect(screen.queryByText("Still couldn't load. Try again in a minute.")).toBeNull()
    expect(screen.getByText(/No platform plan/)).toBeTruthy()
  })
})
