// TZ.14 — staff screens read a record in its studio's zone (D3 = A), with the
// zone's abbreviation only when that zone is not the phone's own.
//
// The Europe/Dublin byte-identity sweep against a frozen pre-change copy ran in
// TZ.14 and was retired in TZ.18b: Dublin is pinned below by fixed values, and
// zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test: nothing may read the host clock
import { describe, it, expect, beforeEach } from 'vitest'

const Z = await import('./studio-zone.js')
const { reviewComparisonView } = await import('./invoice-review.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// Winter; both sides of the EU spring-forward (29 Mar 01:00Z); 00:30 IST on
// 2 Jul (the day differs from UTC); both 01:30s of the EU fall-back (25 Oct 01:00Z).
const P = ['2026-01-15T14:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-07-01T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']

describe('TZ.14 Europe/Dublin pinned values (viewer on Dublin)', () => {
  it('contract detail date+time', () => {
    expect(P.map((iso) => Z.studioDateTimeLabel(iso, DUB, DUB))).toEqual([
      '15 Jan 2026, 14:30', '29 Mar 2026, 00:59', '29 Mar 2026, 02:00',
      '2 Jul 2026, 00:30', '25 Oct 2026, 01:30', '25 Oct 2026, 01:30',
    ])
  })
  it('contract list date', () => {
    expect(P.map((iso) => Z.studioDateLabel(iso, DUB))).toEqual([
      '15 Jan 2026', '29 Mar 2026', '29 Mar 2026', '2 Jul 2026', '25 Oct 2026', '25 Oct 2026',
    ])
  })
  it('AC "as of" time', () => {
    expect(P.map((iso) => Z.studioTimeLabel(iso, DUB, DUB))).toEqual(['14:30', '00:59', '02:00', '00:30', '01:30', '01:30'])
  })
  it('the empty and unparseable cases', () => {
    expect(Z.studioDateTimeLabel(null, DUB, DUB)).toBe('')
    expect(Z.studioDateLabel('', DUB)).toBe('')
    expect(Z.studioTimeLabel(null, DUB, DUB)).toBeNull()
    expect(Z.studioTimeLabel('not a date', DUB, DUB)).toBeNull()
  })
  it('policy effective dates (a Postgres date) render that calendar day', () => {
    expect(['2026-01-15', '2026-03-29', '2026-10-25', '2026-12-31'].map((d) => Z.dateOnlyLabel(d)))
      .toEqual(['15 Jan 2026', '29 Mar 2026', '25 Oct 2026', '31 Dec 2026'])
  })
  it('invoice "as approved on" heading (zone omitted = Dublin)', () => {
    const heading = (iso, ...zone) => reviewComparisonView({ invoice_amount: 10, review_comparison: { primary: { source: 'snapshot', as_of: iso, comparison: 'match' } } }, ...zone).heading
    expect(heading('2026-07-01T23:30:00Z', DUB)).toBe('Roster vs invoice, as approved on 2 Jul 2026')
    expect(heading('2026-07-01T23:30:00Z')).toBe('Roster vs invoice, as approved on 2 Jul 2026')
    expect(heading('2026-03-29T01:00:00Z', DUB)).toBe('Roster vs invoice, as approved on 29 Mar 2026')
    expect(heading('2026-10-25T00:30:00Z', DUB)).toBe('Roster vs invoice, as approved on 25 Oct 2026')
    expect(heading('2026-01-15T14:30:00Z')).toBe('Roster vs invoice, as approved on 15 Jan 2026')
  })
})

describe('TZ.14 America/New_York follows New York across DST', () => {
  it('a 09:00 class reads 09:00 in summer (13:00Z) and winter (14:00Z)', () => {
    expect(Z.studioTimeLabel('2026-07-15T13:00:00Z', NY, NY)).toBe('09:00')
    expect(Z.studioTimeLabel('2026-12-15T14:00:00Z', NY, NY)).toBe('09:00')
  })
  it('the day flips at New York midnight, not Dublin midnight', () => {
    // 2026-11-01T03:30Z: 23:30 EDT on 31 Oct in New York, 03:30 GMT on 1 Nov in Dublin.
    expect(Z.studioDateLabel('2026-11-01T03:30:00Z', NY)).toBe('31 Oct 2026')
    expect(Z.studioDateLabel('2026-11-01T03:30:00Z', DUB)).toBe('1 Nov 2026')
    expect(Z.studioDateLabel('2026-11-01T04:30:00Z', NY)).toBe('1 Nov 2026')
  })
  it('spring forward: 01:59 EST then 03:00 EDT one minute later', () => {
    expect(Z.studioTimeLabel('2026-03-08T06:59:00Z', NY, NY)).toBe('01:59')
    expect(Z.studioTimeLabel('2026-03-08T07:00:00Z', NY, NY)).toBe('03:00')
  })
  it('a policy date is the same calendar day in a zone behind UTC', () => {
    expect(Z.dateOnlyLabel('2026-03-01')).toBe('1 Mar 2026')
  })
  it('the invoice approval day is the invoice studio\'s day', () => {
    const data = { invoice_amount: 1, review_comparison: { primary: { source: 'snapshot', as_of: '2026-11-01T03:30:00Z', comparison: 'match' } } }
    expect(reviewComparisonView(data, NY).heading).toBe('Roster vs invoice, as approved on 31 Oct 2026')
  })
})

describe('TZ.14 D3: the abbreviation appears only when the record zone is not the viewer\'s', () => {
  it('same zone: no suffix', () => {
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', NY, NY)).toBe('')
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', 'Asia/Kolkata', 'Asia/Calcutta')).toBe('')
  })
  it('unknown viewer zone: no suffix (the pre-TZ.14 text)', () => {
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', NY, null)).toBe('')
  })
  it('a New York record seen from Dublin carries EDT / EST', () => {
    expect(Z.studioTimeLabel('2026-07-15T13:00:00Z', NY, DUB)).toBe('09:00 EDT')
    expect(Z.studioTimeLabel('2026-12-15T14:00:00Z', NY, DUB)).toBe('09:00 EST')
    expect(Z.studioDateTimeLabel('2026-12-15T14:00:00Z', NY, DUB)).toBe('15 Dec 2026, 09:00 EST')
  })
  it('a Dublin record seen from New York carries GMT / IST', () => {
    expect(Z.studioTimeLabel('2026-01-15T09:00:00Z', DUB, NY)).toBe('09:00 GMT')
    expect(Z.studioTimeLabel('2026-07-15T08:00:00Z', DUB, NY)).toBe('09:00 IST')
  })
  it('London summer is BST; a zone with no letters keeps its offset', () => {
    expect(Z.zoneAbbrev('2026-07-15T08:00:00Z', 'Europe/London')).toBe('BST')
    expect(Z.zoneAbbrev('2026-07-15T08:00:00Z', 'Australia/Sydney')).toBe('AEST')
    expect(Z.zoneAbbrev('2026-07-15T08:00:00Z', 'Asia/Tokyo')).toBe('GMT+9')
  })
  it('a date-only label never carries a suffix', () => {
    expect(Z.studioDateLabel('2026-12-15T14:00:00Z', NY)).toBe('15 Dec 2026')
  })
})

describe('TZ.14 locationZoneResolver', () => {
  const auth = {
    locations: [{ id: 'dub', timezone: DUB }, { id: 'ny', timezone: NY }, { id: 'bad', timezone: '+05:00' }, { id: 'old' }],
    activeLocation: { id: 'ny', timezone: NY },
  }
  it('reads each location\'s own zone from /api/mobile/me', () => {
    const zoneOf = Z.locationZoneResolver(auth)
    expect(zoneOf('dub')).toBe(DUB)
    expect(zoneOf('ny')).toBe(NY)
  })
  it('an invalid or absent column (an older server) is the platform default', () => {
    const zoneOf = Z.locationZoneResolver(auth)
    expect(zoneOf('bad')).toBe(DUB)
    expect(zoneOf('old')).toBe(DUB)
  })
  it('a record from a studio outside the session takes the active studio\'s zone', () => {
    expect(Z.locationZoneResolver(auth)('elsewhere')).toBe(NY)
    expect(Z.locationZoneResolver(auth)(null)).toBe(NY)
  })
  it('no session at all is the platform default', () => {
    expect(Z.locationZoneResolver({})('x')).toBe(DUB)
  })
})

describe('TZ.14 deviceZone', () => {
  beforeEach(() => Z._resetDeviceZone())
  it('reads the runtime zone once', () => {
    expect(Z.deviceZone()).toBe('America/Los_Angeles')
  })
})
