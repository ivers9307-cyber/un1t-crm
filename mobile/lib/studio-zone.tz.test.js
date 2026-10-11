// TZ.14 — staff screens read a record in its studio's zone (D3 = A), with the
// zone's abbreviation only when that zone is not the phone's own.
process.env.TZ = 'America/Los_Angeles' // neither zone under test: nothing may read the host clock
import { describe, it, expect, beforeEach } from 'vitest'

const Z = await import('./studio-zone.js')
const L = await import('./tz14-screens.legacy-dublin.test-helpers.js')
const { reviewComparisonView } = await import('./invoice-review.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
// Every day of 2026 at four instants, incl. both sides of Dublin midnight.
const DAYS_2026 = []
for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 86_400_000) {
  for (const h of [0, 7, 22.5, 23.5]) DAYS_2026.push(new Date(ms + h * 3_600_000).toISOString())
}
const ALL = [...SAMPLES, ...DAYS_2026]

describe('TZ.14 Europe/Dublin renders byte-identically (viewer on Dublin)', () => {
  it('contract detail date+time', () => {
    for (const iso of ALL) expect(Z.studioDateTimeLabel(iso, DUB, DUB)).toBe(L.contractDetailFmtDateLegacy(iso))
  })
  it('contract list date', () => {
    for (const iso of ALL) expect(Z.studioDateLabel(iso, DUB)).toBe(L.dateFmtLegacy(iso))
  })
  it('AC "as of" time', () => {
    for (const iso of ALL) expect(Z.studioTimeLabel(iso, DUB, DUB)).toBe(L.asOfLabelLegacy(iso))
  })
  it('the empty and unparseable cases keep their old answers', () => {
    expect(Z.studioDateTimeLabel(null, DUB, DUB)).toBe(L.contractDetailFmtDateLegacy(null))
    expect(Z.studioDateLabel('', DUB)).toBe(L.dateFmtLegacy(''))
    expect(Z.studioTimeLabel(null, DUB, DUB)).toBe(L.asOfLabelLegacy(null))
    expect(Z.studioTimeLabel('not a date', DUB, DUB)).toBe(L.asOfLabelLegacy('not a date'))
  })
  it('policy effective dates (a Postgres date) render the same day as before, for every date of 2026', () => {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 86_400_000) {
      const d = new Date(ms).toISOString().slice(0, 10)
      expect(Z.dateOnlyLabel(d)).toBe(L.dateFmtLegacy(d))
    }
  })
  it('invoice "as approved on" heading', () => {
    for (const iso of ALL) {
      const data = { invoice_amount: 10, review_comparison: { primary: { source: 'snapshot', as_of: iso, comparison: 'match' } } }
      expect(reviewComparisonView(data, DUB).heading).toBe(`Roster vs invoice, as approved on ${L.invoiceFormatDayLegacy(iso)}`)
      expect(reviewComparisonView(data).heading).toBe(reviewComparisonView(data, DUB).heading)
    }
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
    expect(Z.zoneAbbrev('2026-07-15T08:00:00Z', 'Australia/Sydney')).toMatch(/^GMT\+10$/)
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
