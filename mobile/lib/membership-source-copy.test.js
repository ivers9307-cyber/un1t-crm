// W1.M3c — the phone's membership-source copy decisions. The components
// (BusinessDashboard, StudioDashboard) only render what these return; there
// is no RN component test runner, so the behaviour is pinned here.

import { describe, it, expect } from 'vitest'
import { readMembershipSource, membershipSourceCard, businessMembershipView, studioFunnelNote } from './membership-source-copy'

const CONFIGURED = { source: 'glofox', state: 'configured', label: 'Glofox', provides_memberships: true, can_manage: false }
const NONE = { source: 'none', state: 'none', label: 'No membership source', provides_memberships: false, can_manage: false }
const UNCONFIGURED = { source: 'glofox', state: 'unconfigured', label: 'Glofox', missing: ['Branch ID', 'API Key'], provides_memberships: true, can_manage: false }
const UNKNOWN = { source: null, state: 'unknown', label: null, provides_memberships: true, can_manage: false }

const NONE_TITLE = 'No membership source connected'
const RETRY_TITLE = 'Membership data could not be read right now'

describe('readMembershipSource', () => {
  it('absent or malformed is unknown and NOT reported, never none', () => {
    for (const raw of [undefined, null, 'none', [], {}, { source: 'none' }, { state: 3 }]) {
      const s = readMembershipSource(raw)
      expect(s).toMatchObject({ source: 'unknown', state: 'unknown', reported: false })
      expect(s.state).not.toBe('none')
    }
  })

  it('a configured payload reads back as reported + configured', () => {
    expect(readMembershipSource(CONFIGURED)).toEqual({
      source: 'glofox', state: 'configured', label: 'Glofox', missing: [], providesMemberships: true, canManage: false, reported: true,
    })
  })

  it('a reported unknown keeps unknown (the retry card), with source unknown', () => {
    expect(readMembershipSource(UNKNOWN)).toMatchObject({ source: 'unknown', state: 'unknown', reported: true })
  })

  it('a state this bundle does not know (a newer server) is a REPORTED unknown', () => {
    expect(readMembershipSource({ source: 'un1t', state: 'migrating' })).toMatchObject({ source: 'un1t', state: 'unknown', reported: true })
  })

  it('keeps only string missing names; can_manage must be literally true', () => {
    const s = readMembershipSource({ ...UNCONFIGURED, missing: ['API Key', 4, '', null], can_manage: 'yes' })
    expect(s.missing).toEqual(['API Key'])
    expect(s.canManage).toBe(false)
  })
})

describe('membershipSourceCard', () => {
  it('configured and providing memberships: no card (the numbers render)', () => {
    expect(membershipSourceCard(readMembershipSource(CONFIGURED))).toBeNull()
  })

  it('none: the none copy; "Ask an owner" for a non-owner, "Choose one" for an owner', () => {
    const staff = membershipSourceCard(readMembershipSource(NONE))
    expect(staff.state).toBe('none')
    expect(staff.title).toBe(NONE_TITLE)
    expect(staff.body).toBe('This studio has no membership source, so there is no membership data to show. Ask an owner to connect a membership source.')
    const owner = membershipSourceCard(readMembershipSource({ ...NONE, can_manage: true }))
    expect(owner.body).toBe('This studio has no membership source, so there is no membership data to show. Choose one on the web in Location settings → Integrations.')
  })

  it('unconfigured: names the provider and what is missing', () => {
    const card = membershipSourceCard(readMembershipSource(UNCONFIGURED))
    expect(card).toEqual({
      state: 'unconfigured',
      title: 'Glofox is selected but not fully configured',
      body: 'Missing: Branch ID, API Key. Ask an owner to connect a membership source.',
    })
    const owner = membershipSourceCard(readMembershipSource({ ...UNCONFIGURED, missing: [], can_manage: true }))
    expect(owner.body).toBe('Missing: its credentials. Finish setting it up on the web in Location settings → Integrations.')
  })

  it('unknown: the retry copy, NEVER the none copy', () => {
    const card = membershipSourceCard(readMembershipSource(UNKNOWN))
    expect(card.state).toBe('unknown')
    expect(card.title).toBe(RETRY_TITLE)
    expect(card.body).toMatch(/^Pull down to try again\./)
    expect(card.title).not.toBe(NONE_TITLE)
    expect(card.body).not.toMatch(/no membership source/i)
  })

  it('a configured source without membership data says so', () => {
    const card = membershipSourceCard(readMembershipSource({ ...CONFIGURED, provides_memberships: false }))
    expect(card.title).toBe('Glofox does not provide membership data')
  })

  it('no_location: choose a location', () => {
    expect(membershipSourceCard(readMembershipSource({ source: null, state: 'no_location' })).title).toBe('Choose a location')
  })

  it('an un-normalised or missing argument is the retry card, never none', () => {
    expect(membershipSourceCard(undefined).title).toBe(RETRY_TITLE)
  })

  it('no copy carries an em-dash', () => {
    const all = [CONFIGURED, NONE, UNCONFIGURED, UNKNOWN, { state: 'no_location' }, { ...CONFIGURED, provides_memberships: false }]
      .flatMap((raw) => [raw, { ...raw, can_manage: true }])
      .map((raw) => membershipSourceCard(readMembershipSource(raw)))
      .filter(Boolean)
    for (const c of all) {
      expect(c.title).not.toContain('—')
      expect(c.body).not.toContain('—')
    }
  })
})

describe('businessMembershipView', () => {
  it('Stillorgan (configured glofox): the numbers render exactly as before, no card', () => {
    expect(businessMembershipView(readMembershipSource(CONFIGURED))).toEqual({ showNumbers: true, card: null })
  })

  it('a studio with no source: the none card stands in for the KPI row and the membership section', () => {
    const v = businessMembershipView(readMembershipSource(NONE))
    expect(v.showNumbers).toBe(false)
    expect(v.card.title).toBe(NONE_TITLE)
  })

  it('unconfigured: the card, not the numbers', () => {
    const v = businessMembershipView(readMembershipSource(UNCONFIGURED))
    expect(v.showNumbers).toBe(false)
    expect(v.card.state).toBe('unconfigured')
  })

  it('a reported unknown: the retry card, never none', () => {
    const v = businessMembershipView(readMembershipSource(UNKNOWN))
    expect(v.showNumbers).toBe(false)
    expect(v.card.title).toBe(RETRY_TITLE)
  })

  it('NOT reported (a web deploy older than this bundle): render as before', () => {
    expect(businessMembershipView(readMembershipSource(undefined))).toEqual({ showNumbers: true, card: null })
    expect(businessMembershipView(undefined)).toEqual({ showNumbers: true, card: null })
  })
})

describe('studioFunnelNote', () => {
  const COUNTS = { newLeadsThisWeek: 3, funnel: { new_lead: 3 }, totalContacts: 9 }

  it('configured: no note (Stillorgan unchanged)', () => {
    expect(studioFunnelNote({ ...COUNTS, membership_source: CONFIGURED })).toBeNull()
  })

  it('failed counts (null) or an older server (no key): no note', () => {
    expect(studioFunnelNote(null)).toBeNull()
    expect(studioFunnelNote(COUNTS)).toBeNull()
  })

  it('none: says the later stages will not move; owner vs not', () => {
    const n = studioFunnelNote({ ...COUNTS, membership_source: NONE })
    expect(n.state).toBe('none')
    expect(n.text).toBe('No membership source connected. Stages that depend on memberships and credits will not move; leads still enter and go dormant. Ask an owner to connect a membership source.')
    expect(studioFunnelNote({ ...COUNTS, membership_source: { ...NONE, can_manage: true } }).text)
      .toMatch(/Choose one on the web in Location settings → Integrations\.$/)
  })

  it('unconfigured: names the provider and what is missing', () => {
    expect(studioFunnelNote({ ...COUNTS, membership_source: UNCONFIGURED }).text)
      .toBe('Glofox is selected but not fully configured (missing: Branch ID, API Key), so stages that depend on memberships will not move. Ask an owner to connect a membership source.')
  })

  it('unknown: no note (mirrors the web pipeline note, which fires only for a known none)', () => {
    expect(studioFunnelNote({ ...COUNTS, membership_source: UNKNOWN })).toBeNull()
    expect(studioFunnelNote({ ...COUNTS, membership_source: { ...UNKNOWN, state: 'something_new' } })).toBeNull()
  })

  it('no note carries an em-dash', () => {
    for (const ms of [NONE, UNCONFIGURED, { ...CONFIGURED, provides_memberships: false }]) {
      for (const can_manage of [true, false]) {
        expect(studioFunnelNote({ ...COUNTS, membership_source: { ...ms, can_manage } }).text).not.toContain('—')
      }
    }
  })
})
