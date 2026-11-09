import { describe, it, expect } from 'vitest'
import { isNavActive, LINKS } from './HostNav.jsx'

// Pure-function test only — isNavActive has no DOM/hook dependency, so no
// react-dom/server render or next/navigation mock is needed here.
const OVERVIEW = { href: '/host', label: 'Overview', exact: true }
const EVENTS = { href: '/host/events', label: 'Events', exact: false }
const YOUR_PAGE = { href: '/host/page', label: 'Your page', exact: false }
const CONTACTS = { href: '/host/contacts', label: 'Contacts', exact: false }
const EMAILS = { href: '/host/emails', label: 'Emails', exact: false }

describe('isNavActive', () => {
  it('matches Overview only on the exact /host path', () => {
    expect(isNavActive('/host', OVERVIEW)).toBe(true)
  })

  it('does not light up Overview on a sub-path', () => {
    expect(isNavActive('/host/contacts', OVERVIEW)).toBe(false)
  })

  it('lights Events on the list, an event page and the create page', () => {
    for (const p of ['/host/events', '/host/events/e1', '/host/events/e1/setup', '/host/events/new']) expect(isNavActive(p, EVENTS)).toBe(true)
  })

  it('lights Your page on /host/page only', () => {
    expect(isNavActive('/host/page', YOUR_PAGE)).toBe(true)
    expect(isNavActive('/host/pages', YOUR_PAGE)).toBe(false)
  })

  it('lists the six places in order', () => {
    expect(LINKS.map((l) => l.label)).toEqual(['Overview', 'Events', 'Contacts', 'Emails', 'Earnings', 'Your page'])
  })

  it('prefix-matches Contacts on a nested detail path', () => {
    expect(isNavActive('/host/contacts/x', CONTACTS)).toBe(true)
  })

  it('does not match on a merely string-prefixed sibling path', () => {
    expect(isNavActive('/host/emailsFoo', EMAILS)).toBe(false)
  })
})
