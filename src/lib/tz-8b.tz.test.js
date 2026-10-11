// tz-8b.tz.test.js — TZ.8b: time off, attendance, contracts, equipment,
// qualifications and checklists take EACH STUDIO's zone (locations.timezone).
//
// Two halves, as every sweep: (1) Europe/Dublin is byte-identical to the
// frozen pre-change code (tz-8b.legacy-dublin.test-helpers.js) over the
// DST-edge samples and every hour of 2026; (2) America/New_York follows New
// York's clock across both 2026 US DST changes. The routes' halves are in
// tz-8b.routes.tz.test.js.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => ({ sent: 1, failed: 0, emailed: 0, email_failed: 0, deduped: 0 })) }))

const LEGACY = await import('./tz-8b.legacy-dublin.test-helpers.js')
const { allowanceYearIn, parseAllowanceYear } = await import('./allowance-year.js')
const { retryLabelIn, annotateCancelAsk } = await import('./time-off-cancel.js')
const { profileVariables, mergeVariables } = await import('./contracts.js')
const { signatureWhen } = await import('./contract-pdf.js')
const { formatFullDateTimeInTZ } = await import('./dates.js')
const { digestDaysByOrg, planQualificationDigests, runQualificationDigest } = await import('./qualification-digest.js')
const { notifyUsersOnce } = await import('./push-dedup')
const { mockDb, byTable, filter } = await import('./qualifications-mock-db.test-helpers.js')
const { zoneOfLocation, todayStrIn, resetLocationZoneCache } = await import('./location-time.js')
const { studioZoneFor } = await import('./staff-zone.js')
const { displayZonesFor } = await import('./display-zone.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
]
const HOURS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1, 6); t += 3_600_000) out.push(t)
  return out
})()
const at = (iso) => Date.parse(iso)
const ALL = [...SAMPLES.map(at), ...HOURS_2026]
const atTime = (ms) => vi.useFakeTimers({ toFake: ['Date'], now: ms })

afterEach(() => {
  vi.useRealTimers()
  resetLocationZoneCache()
})

describe('TZ.8b Europe/Dublin is byte-identical', () => {
  it('allowance year: allowanceYearIn / parseAllowanceYear(absent) = the old Dublin year', () => {
    for (const ms of ALL) {
      atTime(ms)
      expect(allowanceYearIn(DUB, ms)).toBe(LEGACY.dublinYearLegacy())
      expect(parseAllowanceYear(null, DUB)).toStrictEqual(LEGACY.parseAllowanceYearLegacy(null))
      expect(parseAllowanceYear('', zoneOfLocation({ timezone: DUB }))).toStrictEqual(LEGACY.parseAllowanceYearLegacy(''))
    }
    for (const raw of [2026, '2026', 'abc', 1999]) expect(parseAllowanceYear(raw, DUB)).toStrictEqual(LEGACY.parseAllowanceYearLegacy(raw))
  }, 60_000)

  it('the re-ask label: retryLabelIn(iso, Dublin) = dublinRetryLabel(iso), every hour and quarter of 2026', () => {
    for (const ms of ALL) {
      for (const q of [0, 15 * 60_000, 30 * 60_000, 59 * 60_000]) {
        const iso = new Date(ms + q).toISOString()
        expect(retryLabelIn(iso, DUB)).toBe(LEGACY.dublinRetryLabelLegacy(iso))
      }
    }
    expect(retryLabelIn(null, DUB)).toBe(LEGACY.dublinRetryLabelLegacy(null))
    expect(retryLabelIn('not a date', DUB)).toBe(LEGACY.dublinRetryLabelLegacy('not a date'))
  }, 60_000)

  it('the contract {{today}} variable and the merged map', () => {
    const profile = { full_name: 'Test Person', email: 'p@example.test', role: 'staff', annual_salary: 40000, hourly_rate: 20 }
    for (const ms of ALL) {
      atTime(ms)
      expect(profileVariables(profile, { zone: DUB })).toStrictEqual(LEGACY.profileVariablesLegacy(profile))
      expect(profileVariables(profile)).toStrictEqual(LEGACY.profileVariablesLegacy(profile))
    }
    atTime(at('2026-06-30T23:30:00Z'))
    expect(mergeVariables(profile, { notice: '4 weeks' }, { zone: DUB })).toStrictEqual({ ...LEGACY.profileVariablesLegacy(profile), notice: '4 weeks' })
  }, 60_000)

  it('the signed-contract PDF stamp and the two emails\' stamps', () => {
    for (const ms of ALL) {
      const iso = new Date(ms).toISOString()
      expect(signatureWhen(iso, DUB)).toBe(LEGACY.signatureWhenLegacy(iso))
      expect(signatureWhen(iso)).toBe(LEGACY.signatureWhenLegacy(iso))
      expect(formatFullDateTimeInTZ(iso, zoneOfLocation({ timezone: DUB }))).toBe(LEGACY.emailStampLegacy(iso))
    }
    expect(signatureWhen(null, DUB)).toBe(LEGACY.signatureWhenLegacy(null))
  }, 60_000)

  it('the qualification digest day: one Dublin organisation\'s day = dublinDayStr(now), every hour of 2026', () => {
    const locs = [{ id: 'loc-b', organization_id: 'org-1', timezone: DUB }, { id: 'loc-a', organization_id: 'org-1', timezone: null }]
    for (const ms of ALL) {
      expect(digestDaysByOrg(locs, ms).get('org-1')).toBe(LEGACY.qualificationDigestDayLegacy(ms))
    }
  }, 60_000)

  it('a route\'s "today" for a Dublin studio = dublinTodayStr()', () => {
    for (const ms of ALL) {
      atTime(ms)
      expect(todayStrIn(zoneOfLocation({ id: 'loc', timezone: DUB }))).toBe(LEGACY.routeTodayLegacy())
      expect(todayStrIn(zoneOfLocation(null))).toBe(LEGACY.routeTodayLegacy())
    }
  }, 60_000)
})

describe('TZ.8b America/New_York follows New York across DST', () => {
  it('the leave year turns at New York midnight, not Dublin\'s', () => {
    // 03:00Z on 1 Jan 2027: 2027 in Dublin, still 22:00 on 31 Dec in New York.
    expect(allowanceYearIn(DUB, at('2027-01-01T03:00:00Z'))).toBe(2027)
    expect(allowanceYearIn(NY, at('2027-01-01T03:00:00Z'))).toBe(2026)
    expect(allowanceYearIn(NY, at('2027-01-01T04:59:00Z'))).toBe(2026)
    expect(allowanceYearIn(NY, at('2027-01-01T05:00:00Z'))).toBe(2027)
    atTime(at('2027-01-01T03:00:00Z'))
    expect(parseAllowanceYear(undefined, NY)).toEqual({ year: 2026, error: null })
    expect(parseAllowanceYear(undefined, DUB)).toEqual({ year: 2027, error: null })
  })

  it('the re-ask label reads New York wall clock in summer, winter and across fall-back', () => {
    expect(retryLabelIn('2026-07-01T03:30:00.000Z', NY)).toBe('23:30 on 30 Jun') // EDT
    expect(retryLabelIn('2026-12-01T14:30:00.000Z', NY)).toBe('09:30 on 1 Dec') // EST
    expect(retryLabelIn('2026-11-01T05:30:00.000Z', NY)).toBe('01:30 on 1 Nov') // 01:30 EDT
    expect(retryLabelIn('2026-11-01T06:30:00.000Z', NY)).toBe('01:30 on 1 Nov') // 01:30 EST, after fall-back
    expect(retryLabelIn('2026-03-08T07:30:00.000Z', NY)).toBe('03:30 on 8 Mar') // spring-forward: 02:xx never happens
  })

  it('annotateCancelAsk words the wait in the request\'s studio zone', () => {
    const user = { id: 'mgr', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] }
    const declined = {
      id: 'r1', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', start_date: '2026-12-10', end_date: '2026-12-12',
      cancel_requested_at: '2026-11-30T10:00:00Z', cancel_decided_at: '2026-11-30T14:30:00Z', cancel_decision: 'rejected',
    }
    const nowMs = at('2026-11-30T15:00:00Z')
    const ny = annotateCancelAsk(declined, user, '2026-11-30', ['loc-1'], nowMs, NY)
    const dub = annotateCancelAsk(declined, user, '2026-11-30', ['loc-1'], nowMs, DUB)
    const dflt = annotateCancelAsk(declined, user, '2026-11-30', ['loc-1'], nowMs)
    expect(dub.cancel_retry_after).toBe('2026-12-01T14:30:00.000Z')
    expect(dub.cancel_retry_after_label).toBe('14:30 on 1 Dec')
    expect(dflt).toStrictEqual(dub)
    expect(ny.cancel_retry_after_label).toBe('09:30 on 1 Dec')
    expect({ ...ny, cancel_retry_after_label: null }).toStrictEqual({ ...dub, cancel_retry_after_label: null })
  })

  it('{{today}} is the issuing studio\'s day', () => {
    atTime(at('2026-07-01T03:30:00Z')) // 04:30 IST on 1 Jul; 23:30 EDT on 30 Jun
    expect(profileVariables({ full_name: 'X' }, { zone: NY }).today).toBe('2026-06-30')
    expect(profileVariables({ full_name: 'X' }, { zone: DUB }).today).toBe('2026-07-01')
    expect(mergeVariables({ full_name: 'X' }, {}, { zone: NY }).today).toBe('2026-06-30')
    atTime(at('2026-11-01T04:30:00Z')) // 00:30 EDT on 1 Nov, the US fall-back day
    expect(profileVariables(null, { zone: NY })).toEqual({})
    expect(profileVariables({ role: 'staff' }, { zone: NY }).today).toBe('2026-11-01')
  })

  it('a signature prints New York wall clock (EDT in summer, EST in winter)', () => {
    expect(signatureWhen('2026-07-01T13:30:00Z', NY)).toBe(formatFullDateTimeInTZ('2026-07-01T13:30:00Z', NY))
    expect(signatureWhen('2026-07-01T13:30:00Z', NY)).toMatch(/09:30/)
    expect(signatureWhen('2026-12-01T14:30:00Z', NY)).toMatch(/09:30/)
    expect(signatureWhen('2026-12-01T14:30:00Z', DUB)).toMatch(/14:30/)
  })

  it('an organisation\'s digest day flips at its studios\' midnight; the lowest studio id decides a mixed one', () => {
    const locs = [
      { id: 'b-dub', organization_id: 'org-mixed', timezone: DUB },
      { id: 'a-ny', organization_id: 'org-mixed', timezone: NY },
      { id: 'c-ny', organization_id: 'org-ny', timezone: NY },
      { id: 'd-dub', organization_id: 'org-dub', timezone: DUB },
    ]
    const d = digestDaysByOrg(locs, at('2026-07-01T03:30:00Z'))
    expect(Object.fromEntries(d)).toEqual({ 'org-mixed': '2026-06-30', 'org-ny': '2026-06-30', 'org-dub': '2026-07-01' })
    // fall-back day: 1 Nov is 25 hours long in New York (04:00Z to 05:00Z next day)
    expect(digestDaysByOrg(locs, at('2026-11-01T03:59:00Z')).get('org-ny')).toBe('2026-10-31')
    expect(digestDaysByOrg(locs, at('2026-11-01T04:00:00Z')).get('org-ny')).toBe('2026-11-01')
    expect(digestDaysByOrg(locs, at('2026-11-02T04:59:00Z')).get('org-ny')).toBe('2026-11-01')
    expect(digestDaysByOrg(locs, at('2026-11-02T05:00:00Z')).get('org-ny')).toBe('2026-11-02')
  })

  // A New York org and a Dublin org, both with a record expiring on 29 Oct,
  // at 03:30Z on Mon 28 Sep 2026: Monday in Dublin, still Sunday 27 Sep in New York.
  const LOCS = [
    { id: 'loc-ny', name: 'NY', organization_id: 'org-ny', timezone: NY },
    { id: 'loc-dub', name: 'Dub', organization_id: 'org-dub', timezone: DUB },
  ]
  const ORGS = [{ id: 'org-ny', name: 'NY Co' }, { id: 'org-dub', name: 'Dub Co' }]
  const person = (id) => ({ id, full_name: id, role: 'staff', active: true, deleted_at: null })
  const LINKS = [
    { profile_id: 'own-ny', location_id: 'loc-ny', role: 'owner', profiles: person('own-ny') },
    { profile_id: 'coach-ny', location_id: 'loc-ny', role: 'staff', profiles: person('coach-ny') },
    { profile_id: 'own-dub', location_id: 'loc-dub', role: 'owner', profiles: person('own-dub') },
    { profile_id: 'coach-dub', location_id: 'loc-dub', role: 'staff', profiles: person('coach-dub') },
  ]
  const TYPES = [{ id: 't-ny', organization_id: 'org-ny', name: 'CPR', active: true }, { id: 't-dub', organization_id: 'org-dub', name: 'CPR', active: true }]
  const RECORDS = [
    { id: 'r-ny', organization_id: 'org-ny', profile_id: 'coach-ny', qualification_type_id: 't-ny', expires_on: '2026-10-28' },
    { id: 'r-dub', organization_id: 'org-dub', profile_id: 'coach-dub', qualification_type_id: 't-dub', expires_on: '2026-10-28' },
  ]
  // 13:00Z: inside 07:00-22:00 in both zones, so quiet hours stay out of it.
  const NOW = at('2026-09-28T03:30:00Z')
  const NOON = at('2026-09-28T13:00:00Z')

  it('the planner keys each organisation by its own day and week', () => {
    const todayByOrg = new Map([['org-ny', '2026-09-27'], ['org-dub', '2026-09-28']])
    const out = planQualificationDigests({ locations: LOCS, organizations: ORGS, links: LINKS, types: TYPES, records: RECORDS, todayISO: '2026-09-28', nowMs: NOON, todayByOrg })
    const byOrg = Object.fromEntries(out.plans.map((p) => [p.organizationId, p]))
    // New York's Sunday 27 Sep belongs to the week of Mon 21 Sep; 28 Oct is 31 days out: not yet due.
    expect(byOrg['org-ny']).toBeUndefined()
    expect(out.nothing_due).toBe(1)
    expect(byOrg['org-dub'].eventKey).toBe('qualification_digest:org-dub:2026-09-28')
    expect(byOrg['org-dub'].attemptKey).toBe('qualification_digest:org-dub:2026-09-28:d2026-09-28')
    // Without todayByOrg the planner is the old one: one day for everyone.
    const flat = planQualificationDigests({ locations: LOCS, organizations: ORGS, links: LINKS, types: TYPES, records: RECORDS, todayISO: '2026-09-27', nowMs: NOON })
    expect(flat.plans.map((p) => p.attemptKey)).toEqual([])
  })

  it('the planner gives a New York organisation its own week key once its day is due', () => {
    const todayByOrg = new Map([['org-ny', '2026-09-28'], ['org-dub', '2026-09-29']])
    const out = planQualificationDigests({ locations: LOCS, organizations: ORGS, links: LINKS, types: TYPES, records: RECORDS, todayISO: '2026-09-29', nowMs: NOON, todayByOrg })
    expect(out.plans.map((p) => [p.organizationId, p.eventKey, p.attemptKey])).toEqual([
      ['org-dub', 'qualification_digest:org-dub:2026-09-28', 'qualification_digest:org-dub:2026-09-28:d2026-09-29'],
      ['org-ny', 'qualification_digest:org-ny:2026-09-28', 'qualification_digest:org-ny:2026-09-28:d2026-09-28'],
    ])
  })

  function runDb(locations = LOCS) {
    return mockDb(byTable({
      locations: { data: locations, error: null },
      organizations: { data: ORGS, error: null },
      profile_locations: { data: LINKS, error: null },
      staff_qualification_types: { data: TYPES, error: null },
      staff_qualifications: { data: RECORDS, error: null },
      'push_event_sends.select': { data: [], error: null },
      'push_event_sends.upsert': { data: null, error: null },
    }))
  }

  it('a run: a Dublin organisation\'s keys are exactly the legacy ones; the records read spans the latest studio day', async () => {
    notifyUsersOnce.mockClear()
    const ms = at('2026-09-29T13:00:00Z') // Tue 29 Sep in both zones
    const db = runDb()
    await runQualificationDigest(db, { nowMs: ms })
    const legacy = LEGACY.qualificationDigestKeysLegacy('org-dub', ms)
    const dubCall = notifyUsersOnce.mock.calls.find((c) => c[2][0] === 'own-dub')
    expect(dubCall[1]).toBe(legacy.attemptKey)
    expect(filter(db.log.find((q) => q.table === 'staff_qualifications'), 'lte', 'expires_on')).toBe(legacy.cutoff)
    const nyCall = notifyUsersOnce.mock.calls.find((c) => c[2][0] === 'own-ny')
    expect(nyCall[1]).toBe('qualification_digest:org-ny:2026-09-28:d2026-09-29')
  })

  it('a run at 03:30Z: New York is still on Sunday (last week), Dublin is on Monday', async () => {
    notifyUsersOnce.mockClear()
    const db = runDb([{ ...LOCS[0], timezone: NY }])
    await runQualificationDigest(db, { nowMs: NOW })
    // The records cutoff is New York's Sunday + 30 days, not Dublin's Monday + 30.
    expect(filter(db.log.find((q) => q.table === 'staff_qualifications'), 'lte', 'expires_on')).toBe('2026-10-27')
  })
})

describe('TZ.8b zone helpers', () => {
  const NY_LOC = { id: 'loc-ny', timezone: NY }
  const DUB_LOC = { id: 'loc-dub', timezone: DUB }
  const noDb = { from: () => { throw new Error('no read expected') } }

  it('studioZoneFor: the session\'s copy first, no read', async () => {
    const user = { activeLocation: NY_LOC, locations: [NY_LOC, DUB_LOC] }
    expect(await studioZoneFor(noDb, user, 'loc-ny')).toBe(NY)
    expect(await studioZoneFor(noDb, user, 'loc-dub')).toBe(DUB)
    expect(await studioZoneFor(noDb, user, null)).toBe(DUB)
  })

  it('studioZoneFor: a studio the session does not hold is read; a failed read throws', async () => {
    const reads = []
    const db = (answer) => ({
      from(table) {
        const chain = {
          select() { return chain }, eq(_c, v) { reads.push([table, v]); return chain },
          maybeSingle: async () => answer,
        }
        return chain
      },
    })
    expect(await studioZoneFor(db({ data: { id: 'loc-x', timezone: NY }, error: null }), { activeLocation: DUB_LOC }, 'loc-x')).toBe(NY)
    expect(reads).toEqual([['locations', 'loc-x']])
    await expect(studioZoneFor(db({ data: null, error: { message: 'down' } }), { activeLocation: DUB_LOC }, 'loc-y'))
      .rejects.toMatchObject({ name: 'LocationZoneReadError' })
  })

  it('displayZonesFor: session rows, then one batch read; a failed read is DEFAULT_TZ for those only', async () => {
    const user = { activeLocation: NY_LOC, locations: [NY_LOC] }
    const ok = {
      from() {
        const chain = { select() { return chain }, in() { return chain }, order: async () => ({ data: [{ id: 'loc-x', timezone: NY }], error: null }) }
        return chain
      },
    }
    expect(Object.fromEntries(await displayZonesFor(ok, user, ['loc-ny', 'loc-x', null], 'test'))).toEqual({ 'loc-ny': NY, 'loc-x': NY })
    const down = {
      from() {
        const chain = { select() { return chain }, in() { return chain }, order: async () => ({ data: null, error: { message: 'down' } }) }
        return chain
      },
    }
    expect(Object.fromEntries(await displayZonesFor(down, user, ['loc-ny', 'loc-z'], 'test'))).toEqual({ 'loc-ny': NY, 'loc-z': DUB })
  })
})
