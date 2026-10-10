// @vitest-environment jsdom
//
// W1.M3a — the ONE gate every Glofox-only web surface renders through.
// Four states, four copies; `configured` renders the children; the "no
// source" copy is NEVER shown for a read failure (an operator must not be
// sent to connect an integration that is merely unreadable right now).
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MembershipSourceGate from './MembershipSourceGate.jsx'

afterEach(cleanup)

const HREF = '/settings/locations/a0000000-0000-4000-8000-00000000000a?section=integrations&tab=glofox'
const GLOFOX_CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }
const NONE_CAPS = { memberships: false, bookings: false, credits: false, invoices: false, schedule: false }
const configured = { source: 'glofox', state: 'configured', label: 'Glofox', capabilities: GLOFOX_CAPS }
const none = { source: 'none', state: 'none', label: 'No membership source', capabilities: NONE_CAPS }
const unconfigured = { source: 'glofox', state: 'unconfigured', missing: ['API Key', 'Branch ID'], label: 'Glofox', capabilities: GLOFOX_CAPS }
const unknown = { source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', label: 'No membership source', capabilities: NONE_CAPS }

const NONE_COPY = /No membership source connected/
const UNKNOWN_COPY = /Membership data could not be read right now/

describe('MembershipSourceGate', () => {
  it('configured → the children, none of the gate copy', () => {
    render(<MembershipSourceGate state={configured} capability="memberships" settingsHref={HREF}><p>the radar</p></MembershipSourceGate>)
    expect(screen.getByText('the radar')).toBeTruthy()
    expect(screen.queryByText(NONE_COPY)).toBeNull()
    expect(screen.queryByText(UNKNOWN_COPY)).toBeNull()
    expect(document.querySelector('[data-membership-state]')).toBeNull()
  })

  it('none → "No membership source connected", the owner gets a link to Location settings → Integrations', () => {
    render(<MembershipSourceGate state={none} capability="memberships" settingsHref={HREF} canManage><p>the radar</p></MembershipSourceGate>)
    expect(screen.queryByText('the radar')).toBeNull()
    expect(screen.getByText(NONE_COPY)).toBeTruthy()
    expect(screen.getByText(/no membership data to show/)).toBeTruthy()
    const link = screen.getByRole('link', { name: /Location settings → Integrations/ })
    expect(link.getAttribute('href')).toBe(HREF)
    expect(screen.queryByText(/Ask an owner/)).toBeNull()
    expect(document.querySelector('[data-membership-state]').getAttribute('data-membership-state')).toBe('none')
  })

  it('none, not an owner → "Ask an owner", and no settings link', () => {
    render(<MembershipSourceGate state={none} capability="memberships" settingsHref={HREF}><p>x</p></MembershipSourceGate>)
    expect(screen.getByText(NONE_COPY)).toBeTruthy()
    expect(screen.getByText(/Ask an owner to connect a membership source/)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('the capability names what is missing (schedule → "a class schedule")', () => {
    render(<MembershipSourceGate state={none} capability="schedule" settingsHref={HREF}><p>x</p></MembershipSourceGate>)
    expect(screen.getByText(/no class schedule to run on/)).toBeTruthy()
  })

  it('unconfigured → the provider is named with what is missing', () => {
    render(<MembershipSourceGate state={unconfigured} capability="memberships" settingsHref={HREF} canManage><p>x</p></MembershipSourceGate>)
    expect(screen.queryByText('x')).toBeNull()
    expect(screen.getByText('Glofox is selected but not fully configured')).toBeTruthy()
    expect(screen.getByText(/Missing: API Key, Branch ID\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Location settings → Integrations/ }).getAttribute('href')).toBe(HREF)
    expect(screen.queryByText(NONE_COPY)).toBeNull()
    expect(document.querySelector('[data-membership-state]').getAttribute('data-membership-state')).toBe('unconfigured')
  })

  it('unknown → a retry message, and NEVER the "no source" copy or a settings link', () => {
    render(<MembershipSourceGate state={unknown} capability="memberships" settingsHref={HREF} canManage><p>x</p></MembershipSourceGate>)
    expect(screen.queryByText('x')).toBeNull()
    expect(screen.getByText(UNKNOWN_COPY)).toBeTruthy()
    expect(screen.getByText(/Reload to try again/)).toBeTruthy()
    expect(screen.queryByText(NONE_COPY)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('[data-membership-state]').getAttribute('data-membership-state')).toBe('unknown')
  })

  it('a missing state is treated as unknown, never as none', () => {
    render(<MembershipSourceGate capability="memberships" settingsHref={HREF}><p>x</p></MembershipSourceGate>)
    expect(screen.getByText(UNKNOWN_COPY)).toBeTruthy()
    expect(screen.queryByText(NONE_COPY)).toBeNull()
  })

  it('configured, but the source lacks the capability → says so, children hidden', () => {
    const noSchedule = { ...configured, capabilities: { ...GLOFOX_CAPS, schedule: false } }
    render(<MembershipSourceGate state={noSchedule} capability="schedule" settingsHref={HREF}><p>x</p></MembershipSourceGate>)
    expect(screen.queryByText('x')).toBeNull()
    expect(screen.getByText(/Glofox does not provide a class schedule/)).toBeTruthy()
    expect(screen.queryByText(NONE_COPY)).toBeNull()
  })
})
