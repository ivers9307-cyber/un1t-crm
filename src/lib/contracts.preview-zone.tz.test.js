// contracts.preview-zone.tz.test.js — TZ follow-up: the contract wizard and
// template previews render {{today}} in the ISSUING studio's zone, the zone
// POST /api/contracts already stores the body in (TZ.8b). The wizard and the
// route pick that studio with ONE shared rule (issuingLocationLink), so the
// preview and the stored body cannot disagree about which studio issues.
//
// Europe/Dublin is pinned with fixed values (unchanged); America/New_York is
// checked across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const {
  profileVariables, linksInTemplateOrg, issuingLocationLink, issuingZone,
} = await import('./contracts.js')
const { templatePreviewZoneOf } = await import('./display-zone.js')
const { DEFAULT_TZ } = await import('./location-time.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const at = (iso) => Date.parse(iso)
const atTime = (ms) => vi.useFakeTimers({ toFake: ['Date'], now: ms })

afterEach(() => { vi.useRealTimers() })

// The two shapes a recipient's studio links arrive in: POST /api/contracts
// embeds `location`, GET /api/staff (the wizard's list) embeds `locations`.
const routeLink = (id, org, tz, isDefault = false) => ({ location_id: id, is_default: isDefault, location: { id, organization_id: org, timezone: tz } })
const staffLink = (id, org, tz, isDefault = false) => ({ location_id: id, is_default: isDefault, locations: { id, organization_id: org, timezone: tz } })

describe('issuingLocationLink: the studio a contract is issued at', () => {
  const tplA = { organization_id: 'org-a' }
  const tplNull = { organization_id: null }

  it('the recipient\'s default studio in the template\'s org', () => {
    const r = { profile_locations: [routeLink('a1', 'org-a', DUB), routeLink('a2', 'org-a', NY, true)] }
    expect(issuingLocationLink(r, tplA).location_id).toBe('a2')
  })

  it('a default in ANOTHER org does not count; the first studio in the org does', () => {
    const r = { profile_locations: [routeLink('b1', 'org-b', DUB, true), routeLink('a1', 'org-a', NY), routeLink('a2', 'org-a', DUB)] }
    expect(issuingLocationLink(r, tplA).location_id).toBe('a1')
  })

  it('a null-org template (master-only) uses all the recipient\'s studios', () => {
    const r = { profile_locations: [routeLink('b1', 'org-b', DUB), routeLink('a1', 'org-a', NY, true)] }
    expect(issuingLocationLink(r, tplNull).location_id).toBe('a1')
  })

  it('reads the staff API\'s `locations` embed, and the caller\'s locationOrgs when there is no embed', () => {
    const embedded = { profile_locations: [staffLink('b1', 'org-b', DUB, true), staffLink('a1', 'org-a', NY)] }
    expect(issuingLocationLink(embedded, tplA).location_id).toBe('a1')
    const bare = { profile_locations: [{ location_id: 'b1', is_default: true }, { location_id: 'a1' }] }
    expect(issuingLocationLink(bare, tplA, { a1: 'org-a', b1: 'org-b' }).location_id).toBe('a1')
    expect(issuingLocationLink(bare, tplA)).toBeNull() // no way to tell the org
  })

  it('no studio in the org (or no recipient): null', () => {
    expect(issuingLocationLink({ profile_locations: [routeLink('b1', 'org-b', DUB)] }, tplA)).toBeNull()
    expect(issuingLocationLink(null, tplA)).toBeNull()
    expect(linksInTemplateOrg(undefined, tplA)).toEqual([])
  })
})

describe('issuingZone: the zone {{today}} is rendered in', () => {
  const tplA = { organization_id: 'org-a' }

  it('the issuing studio\'s own timezone, from the embed', () => {
    expect(issuingZone({ profile_locations: [staffLink('a1', 'org-a', NY, true)] }, tplA)).toBe(NY)
    expect(issuingZone({ profile_locations: [routeLink('a1', 'org-a', DUB, true)] }, tplA)).toBe(DUB)
  })

  it('the server-provided locationZones map wins over an embed', () => {
    const r = { profile_locations: [{ location_id: 'a1', is_default: true }] }
    expect(issuingZone(r, tplA, { locationOrgs: { a1: 'org-a' }, locationZones: { a1: NY } })).toBe(NY)
  })

  it('a NULL studio timezone is the default zone, as on the server', () => {
    expect(issuingZone({ profile_locations: [staffLink('a1', 'org-a', null, true)] }, tplA)).toBe(DEFAULT_TZ)
  })

  it('no issuing studio, or an embed without a timezone: DEFAULT_TZ (the route\'s zoneOfLocation(null))', () => {
    expect(issuingZone({ profile_locations: [] }, tplA)).toBe(DEFAULT_TZ)
    expect(issuingZone(null, tplA)).toBe(DEFAULT_TZ)
    const slim = { profile_locations: [{ location_id: 'a1', is_default: true, locations: { id: 'a1', organization_id: 'org-a' } }] }
    expect(issuingZone(slim, tplA)).toBe(DEFAULT_TZ)
  })
})

describe('the previewed {{today}} is the issuing studio\'s day', () => {
  const tpl = { organization_id: 'org-a' }
  const dubRecipient = { full_name: 'X', profile_locations: [staffLink('a1', 'org-a', DUB, true)] }
  const nyRecipient = { full_name: 'X', profile_locations: [staffLink('a2', 'org-a', NY, true)] }
  const today = (r) => profileVariables(r, { zone: issuingZone(r, tpl) }).today

  it('Europe/Dublin just after local midnight in summer is unchanged (fixed value)', () => {
    atTime(at('2026-07-15T23:30:00Z')) // 00:30 IST on 16 Jul; 19:30 EDT on 15 Jul
    expect(today(dubRecipient)).toBe('2026-07-16')
    expect(profileVariables({ full_name: 'X' }).today).toBe('2026-07-16') // zone omitted = Dublin
    expect(today(nyRecipient)).toBe('2026-07-15')
  })

  it('America/New_York follows New York\'s midnight across the 2026 spring-forward', () => {
    atTime(at('2026-03-08T05:30:00Z')) // 00:30 EST on 8 Mar (DST starts 07:00Z)
    expect(today(nyRecipient)).toBe('2026-03-08')
    atTime(at('2026-03-09T03:30:00Z')) // 23:30 EDT on 8 Mar; 03:30 GMT on 9 Mar
    expect(today(nyRecipient)).toBe('2026-03-08')
    expect(today(dubRecipient)).toBe('2026-03-09')
    atTime(at('2026-03-09T04:30:00Z')) // 00:30 EDT on 9 Mar
    expect(today(nyRecipient)).toBe('2026-03-09')
  })

  it('America/New_York follows New York\'s midnight across the 2026 fall-back', () => {
    atTime(at('2026-11-01T03:30:00Z')) // 23:30 EDT on 31 Oct
    expect(today(nyRecipient)).toBe('2026-10-31')
    expect(today(dubRecipient)).toBe('2026-11-01')
    atTime(at('2026-11-01T04:30:00Z')) // 00:30 EDT on 1 Nov (falls back at 06:00Z)
    expect(today(nyRecipient)).toBe('2026-11-01')
    atTime(at('2026-11-02T04:30:00Z')) // 23:30 EST on 1 Nov
    expect(today(nyRecipient)).toBe('2026-11-01')
  })
})

describe('templatePreviewZoneOf: a template belongs to an org, so its preview uses a studio of that org', () => {
  const dubA = { id: 'a1', organization_id: 'org-a', timezone: DUB }
  const nyA = { id: 'a2', organization_id: 'org-a', timezone: NY }
  const nyB = { id: 'b1', organization_id: 'org-b', timezone: NY }

  it('the active studio when it is in the template\'s org (or the template has none)', () => {
    expect(templatePreviewZoneOf({ activeLocation: nyA, locations: [dubA, nyA] }, 'org-a')).toBe(NY)
    expect(templatePreviewZoneOf({ activeLocation: dubA, locations: [dubA, nyA] }, 'org-a')).toBe(DUB)
    expect(templatePreviewZoneOf({ activeLocation: nyB, locations: [nyB] }, null)).toBe(NY)
  })

  it('else the viewer\'s first studio in the template\'s org', () => {
    expect(templatePreviewZoneOf({ activeLocation: dubA, locations: [dubA, nyB] }, 'org-b')).toBe(NY)
  })

  it('else the active studio, else DEFAULT_TZ', () => {
    expect(templatePreviewZoneOf({ activeLocation: nyB, locations: [nyB] }, 'org-z')).toBe(NY)
    expect(templatePreviewZoneOf(null, 'org-a')).toBe(DEFAULT_TZ)
    expect(templatePreviewZoneOf({ locations: [] }, null)).toBe(DEFAULT_TZ)
  })
})
