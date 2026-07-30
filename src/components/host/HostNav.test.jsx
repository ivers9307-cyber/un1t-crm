import { describe, it, expect } from 'vitest'
import { isNavActive } from './HostNav.jsx'

// Pure-function test only — isNavActive has no DOM/hook dependency, so no
// react-dom/server render or next/navigation mock is needed here.
const DASHBOARD = { href: '/host', label: 'Dashboard', exact: true }
const CONTACTS = { href: '/host/contacts', label: 'Contacts', exact: false }
const EMAILS = { href: '/host/emails', label: 'Emails', exact: false }

describe('isNavActive', () => {
  it('matches Dashboard only on the exact /host path', () => {
    expect(isNavActive('/host', DASHBOARD)).toBe(true)
  })

  it('does not light up Dashboard on a sub-path', () => {
    expect(isNavActive('/host/contacts', DASHBOARD)).toBe(false)
  })

  it('does not light up any link on an unrelated section', () => {
    expect(isNavActive('/host/events/new', DASHBOARD)).toBe(false)
    expect(isNavActive('/host/events/new', CONTACTS)).toBe(false)
    expect(isNavActive('/host/events/new', EMAILS)).toBe(false)
  })

  it('prefix-matches Contacts on a nested detail path', () => {
    expect(isNavActive('/host/contacts/x', CONTACTS)).toBe(true)
  })

  it('does not match on a merely string-prefixed sibling path', () => {
    expect(isNavActive('/host/emailsFoo', EMAILS)).toBe(false)
  })
})
