// @vitest-environment jsdom
//
// HUBREAD.1 — a card whose read failed must offer NO connect, reconnect,
// manage, disconnect, set-up or edit action: only "Try again". The payload
// below is exactly what assembleIntegrationsHub now returns when every read
// fails (see integrations-hub.test.js), rendered to static markup.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

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
