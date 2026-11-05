// @vitest-environment jsdom
//
// MIASETTINGS.2c — the section list, the section link in the URL, and which
// section a settings path lives in. Review Focus 5: a deep link to a section
// or scope you cannot have falls back to the studio scope and Overview.

import { describe, it, expect, afterEach } from 'vitest'
import { SECTIONS, parseLocation, writeLocation, sectionForPath } from './sections'
import { SECTION_KEYS } from './fields'

afterEach(() => { window.history.replaceState(null, '', '/') })

describe('SECTIONS', () => {
  it('lists every section key, in order, with its menu label', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([...SECTION_KEYS])
    expect(SECTIONS.map((s) => s.label)).toEqual([
      'Overview', 'Personality and voice', 'Handoffs', 'Bookings and sales', 'Messages',
      'Follow-ups', 'Cancellation form', 'Knowledge', 'Member app',
    ])
  })

  it('the organisation scope has overview, personality, handoffs, messages and follow-ups only', () => {
    expect(SECTIONS.filter((s) => s.scopes.includes('org')).map((s) => s.key))
      .toEqual(['overview', 'personality', 'handoffs', 'messages', 'followups'])
    for (const s of SECTIONS) expect(s.scopes).toContain('studio')
  })
})

describe('parseLocation', () => {
  it('no query is Overview in the studio scope', () => {
    expect(parseLocation('', { canOrg: false })).toEqual({ section: 'overview', scope: 'studio' })
    expect(parseLocation(undefined, { canOrg: true })).toEqual({ section: 'overview', scope: 'studio' })
  })

  it('a valid section opens it', () => {
    expect(parseLocation('?section=messages', { canOrg: false })).toEqual({ section: 'messages', scope: 'studio' })
    expect(parseLocation('section=member-app', { canOrg: false })).toEqual({ section: 'member-app', scope: 'studio' })
  })

  it('a nonsense section is Overview', () => {
    expect(parseLocation('?section=nonsense', { canOrg: false })).toEqual({ section: 'overview', scope: 'studio' })
    expect(parseLocation('?section=', { canOrg: true })).toEqual({ section: 'overview', scope: 'studio' })
  })

  it('scope=org opens the organisation scope only for someone who can have it', () => {
    expect(parseLocation('?scope=org', { canOrg: true })).toEqual({ section: 'overview', scope: 'org' })
    expect(parseLocation('?scope=org', { canOrg: false })).toEqual({ section: 'overview', scope: 'studio' })
    expect(parseLocation('?section=messages&scope=org', { canOrg: true })).toEqual({ section: 'messages', scope: 'org' })
    expect(parseLocation('?section=messages&scope=org', { canOrg: false })).toEqual({ section: 'messages', scope: 'studio' })
  })

  it('a studio-only section in the organisation scope is Overview', () => {
    expect(parseLocation('?section=cancellation&scope=org', { canOrg: true })).toEqual({ section: 'overview', scope: 'org' })
    // without org rights the scope falls back first, so the section stands
    expect(parseLocation('?section=cancellation&scope=org', { canOrg: false })).toEqual({ section: 'cancellation', scope: 'studio' })
  })

  it('canOrg defaults to false', () => {
    expect(parseLocation('?scope=org')).toEqual({ section: 'overview', scope: 'studio' })
  })
})

describe('writeLocation', () => {
  it('writes the section and the scope, leaving out the defaults', () => {
    window.history.replaceState(null, '', '/settings/customer-agent')
    writeLocation({ section: 'messages', scope: 'studio' })
    expect(window.location.pathname).toBe('/settings/customer-agent')
    expect(window.location.search).toBe('?section=messages')
    writeLocation({ section: 'followups', scope: 'org' })
    expect(window.location.search).toBe('?section=followups&scope=org')
    writeLocation({ section: 'overview', scope: 'studio' })
    expect(window.location.search).toBe('')
  })

  it('keeps any other query parameter and adds no history entry', () => {
    window.history.replaceState(null, '', '/settings/customer-agent?from=hub')
    const before = window.history.length
    writeLocation({ section: 'knowledge', scope: 'studio' })
    expect(window.location.search).toBe('?from=hub&section=knowledge')
    expect(window.history.length).toBe(before)
  })
})

describe('sectionForPath', () => {
  it('maps one field of each section that holds settings', () => {
    expect(sectionForPath('quiet_hours.start')).toBe('overview')
    expect(sectionForPath('test_phones')).toBe('overview')
    expect(sectionForPath('tone')).toBe('personality')
    expect(sectionForPath('holding_message')).toBe('handoffs')
    expect(sectionForPath('booking_url')).toBe('bookings')
    expect(sectionForPath('welcome_greeting')).toBe('messages')
    expect(sectionForPath('followups.daily_cap')).toBe('followups')
    expect(sectionForPath('cancellation_form.reason_labels.price')).toBe('cancellation')
    expect(sectionForPath('monthly_points_target')).toBe('member-app')
  })

  it('no settings path lives in Knowledge (it saves as you go)', () => {
    expect(sectionForPath('knowledge')).toBe(null)
  })
})
