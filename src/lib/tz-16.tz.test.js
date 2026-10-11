// tz-16.tz.test.js — TZ.16 (D3 = A, D4 = A). The web display sweep: staff
// screens render each record's instant in its studio's zone, and name the zone
// only when it differs from the viewer's.
//
//   • Europe/Dublin record + Dublin viewer (and an unknown viewer): pinned by
//     fixed text around both 2026 EU DST changes. (TZ.16 proved it byte-identical
//     to frozen pre-change bodies over every hour of 2026; that sweep was retired
//     in TZ.18b, and zoned-time ≡ dublin-time stays proven by
//     shared/zoned-time.parity.test.js.)
//   • America/New_York: the studio's own wall clock across both 2026 US DST
//     changes, with EST/EDT appended for a Dublin viewer and nothing for a New
//     York one.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: nothing may read the host clock
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), useSearchParams: () => new URLSearchParams() }))

const { formatRecordTime } = await import('./record-time.js')
const C = await import('./contract-display-time.js')
const { nextClassLabel } = await import('../components/contact/format.js')
const { asOfLabel } = await import('../components/AcControlPanel.jsx')
const { feedStamp } = await import('../components/CalendarFeedCard.jsx')
const { formatDay } = await import('../components/InvoicesManager.jsx')
const { paidAtLabel } = await import('../components/OfferSalesList.jsx')
const { fmtDateTime } = await import('../components/OrderDetail.jsx')
const { orderRowDate, orderCardDate } = await import('../components/OrdersTable.jsx')
const { fmtClassTime: classClimateTime } = await import('../components/automations/ClassClimateCard.jsx')
const { fmtClassTime: bathroomClimateTime } = await import('../components/automations/BathroomClimateCard.jsx')
const { fmtSynced } = await import('../components/dashboard/AdsRefreshButton.jsx')
const { formatWhen } = await import('../components/host/HostEmailReport.jsx')
const { fmtDt } = await import('../components/AuditLogTable.jsx')
const { forwardTimestamp, forwardedHeaderLines, buildForwardText } = await import('./email-forward.js')
const { attributionStamp, attributionLine } = await import('./mail/reply-quote.js')
const { formatSaleDeadline } = await import('./sale-offers.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'

// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00Z; fall back Sun 25 Oct 01:00Z.
// The Dublin pins: a winter afternoon; both sides of the spring-forward; 00:30
// IST on 2 Jul (a different day from UTC); both 01:30s of the fall-back night.
const PINS = ['2026-01-15T14:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-07-01T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']
// Inputs the sites guard: absent, empty, unparseable.
const EDGE = [null, undefined, '', 'not-a-date']

// [name, render(iso, zone, viewerZone), Dublin text at PINS, Dublin text at EDGE]
const SITES = [
  ['contracts fmtDate (team detail, team list, templates, account detail)', C.contractStamp,
    ['15 Jan 2026, 14:30', '29 Mar 2026, 00:59', '29 Mar 2026, 02:00', '2 Jul 2026, 00:30', '25 Oct 2026, 01:30', '25 Oct 2026, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['account contracts list fmtDate', C.contractDay,
    ['15 Jan 2026', '29 Mar 2026', '29 Mar 2026', '2 Jul 2026', '25 Oct 2026', '25 Oct 2026'],
    ['', '', '', 'Invalid Date']],
  ['contract SignatureBlock', C.contractSignedStamp,
    ['15/1/2026, 14:30:00', '29/3/2026, 00:59:00', '29/3/2026, 02:00:00', '2/7/2026, 00:30:00', '25/10/2026, 01:30:00', '25/10/2026, 01:30:00'],
    ['1/1/1970, 01:00:00', 'Invalid Date', 'Invalid Date', 'Invalid Date']],
  ['AcControlPanel asOfLabel', asOfLabel,
    ['14:30', '00:59', '02:00', '00:30', '01:30', '01:30'],
    [null, null, null, null]],
  ['CalendarFeedCard stamp', feedStamp,
    ['15 Jan, 14:30', '29 Mar, 00:59', '29 Mar, 02:00', '2 Jul, 00:30', '25 Oct, 01:30', '25 Oct, 01:30'],
    [null, null, null, null]],
  ['next-class chip (DealCard, ContactDrawer, ContactHeaderBand)', nextClassLabel,
    ['Thu, 15 Jan', 'Sun, 29 Mar', 'Sun, 29 Mar', 'Thu, 2 Jul', 'Sun, 25 Oct', 'Sun, 25 Oct'],
    ['Thu, 1 Jan', 'Invalid Date', 'Invalid Date', 'Invalid Date']],
  ['InvoicesManager formatDay', formatDay,
    ['15 Jan 2026', '29 Mar 2026', '29 Mar 2026', '2 Jul 2026', '25 Oct 2026', '25 Oct 2026'],
    ['an unknown date', 'an unknown date', 'an unknown date', 'Invalid Date']],
  ['OfferSalesList paid time', paidAtLabel,
    ['Thu, 15 Jan, 14:30', 'Sun, 29 Mar, 00:59', 'Sun, 29 Mar, 02:00', 'Thu, 2 Jul, 00:30', 'Sun, 25 Oct, 01:30', 'Sun, 25 Oct, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['OrderDetail fmtDateTime', fmtDateTime,
    ['15 Jan 2026, 14:30', '29 Mar 2026, 00:59', '29 Mar 2026, 02:00', '2 Jul 2026, 00:30', '25 Oct 2026, 01:30', '25 Oct 2026, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['OrdersTable row', orderRowDate,
    ['15 Jan 2026, 14:30', '29 Mar 2026, 00:59', '29 Mar 2026, 02:00', '2 Jul 2026, 00:30', '25 Oct 2026, 01:30', '25 Oct 2026, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['OrdersTable card', orderCardDate,
    ['15 Jan, 14:30', '29 Mar, 00:59', '29 Mar, 02:00', '2 Jul, 00:30', '25 Oct, 01:30', '25 Oct, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['ClassClimateCard class time', classClimateTime,
    ['Thu, 15 Jan, 14:30', 'Sun, 29 Mar, 00:59', 'Sun, 29 Mar, 02:00', 'Thu, 02 Jul, 00:30', 'Sun, 25 Oct, 01:30', 'Sun, 25 Oct, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['BathroomClimateCard class time', bathroomClimateTime,
    ['Thu, 15 Jan, 14:30', 'Sun, 29 Mar, 00:59', 'Sun, 29 Mar, 02:00', 'Thu, 02 Jul, 00:30', 'Sun, 25 Oct, 01:30', 'Sun, 25 Oct, 01:30'],
    ['', '', '', 'Invalid Date']],
  ['AdsRefreshButton last synced', fmtSynced,
    ['15 Jan, 14:30', '29 Mar, 00:59', '29 Mar, 02:00', '2 Jul, 00:30', '25 Oct, 01:30', '25 Oct, 01:30'],
    ['never', 'never', 'never', 'unknown']],
  ['HostEmailReport formatWhen', formatWhen,
    ['15 Jan, 14:30', '29 Mar, 00:59', '29 Mar, 02:00', '2 Jul, 00:30', '25 Oct, 01:30', '25 Oct, 01:30'],
    ['', '', '', '']],
  ['email-forward Date header', (iso, zone) => forwardTimestamp(iso, zone),
    ['Thu 15 Jan 2026, 14:30', 'Sun 29 Mar 2026, 00:59', 'Sun 29 Mar 2026, 02:00', 'Thu 2 Jul 2026, 00:30', 'Sun 25 Oct 2026, 01:30', 'Sun 25 Oct 2026, 01:30'],
    ['', '', '', '']],
  ['reply attribution stamp', (iso, zone) => attributionStamp(iso, zone),
    ['Thu 15 Jan 2026 at 14:30', 'Sun 29 Mar 2026 at 00:59', 'Sun 29 Mar 2026 at 02:00', 'Thu 2 Jul 2026 at 00:30', 'Sun 25 Oct 2026 at 01:30', 'Sun 25 Oct 2026 at 01:30'],
    ['', '', '', '']],
  ['sale deadline (upper)', (iso, zone) => formatSaleDeadline(iso, { zone }),
    ['THURSDAY 15 JANUARY, 14:30', 'SUNDAY 29 MARCH, 00:59', 'SUNDAY 29 MARCH, 02:00', 'THURSDAY 2 JULY, 00:30', 'SUNDAY 25 OCTOBER, 01:30', 'SUNDAY 25 OCTOBER, 01:30'],
    ['', '', '', '']],
  ['sale deadline (lower)', (iso, zone) => formatSaleDeadline(iso, { uppercase: false, zone }),
    ['Thursday 15 January, 14:30', 'Sunday 29 March, 00:59', 'Sunday 29 March, 02:00', 'Thursday 2 July, 00:30', 'Sunday 25 October, 01:30', 'Sunday 25 October, 01:30'],
    ['', '', '', '']],
]

// The two page-local formatters (a Next page file may export only its route
// fields), pinned by the exact call they now make.
const PAGE_SITES = [
  ['list-health dateLabel', (iso, zone, viewer) => {
    if (!iso) return 'Not recorded'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'Not recorded'
    return formatRecordTime(d, zone, { day: '2-digit', month: 'short', year: 'numeric' }, 'en-IE', viewer)
  }, ['15 Jan 2026', '29 Mar 2026', '29 Mar 2026', '02 Jul 2026', '25 Oct 2026', '25 Oct 2026']],
  ['welcome status "updated"', (iso, zone) => formatRecordTime(new Date(iso), zone, { hour: '2-digit', minute: '2-digit' }, 'en-IE'),
    ['14:30', '00:59', '02:00', '00:30', '01:30', '01:30']],
]

describe('TZ.16 Europe/Dublin pinned values (Dublin record, Dublin or unknown viewer)', () => {
  it.each([...SITES, ...PAGE_SITES])('%s', (_name, next, want) => {
    expect(PINS.map((iso) => next(iso, D, D))).toEqual(want)
    expect(PINS.map((iso) => next(iso, D, null))).toEqual(want)
  })
  it.each(SITES)('%s on absent or unparseable input', (_name, next, _want, wantEdge) => {
    expect(EDGE.map((bad) => next(bad, D, D))).toEqual(wantEdge)
  })
  it('the audit log stays on the platform zone (D4), and is never suffixed', () => {
    expect(PINS.map((iso) => fmtDt(iso))).toEqual([
      '15 Jan 2026, 14:30:00', '29 Mar 2026, 00:59:00', '29 Mar 2026, 02:00:00',
      '02 Jul 2026, 00:30:00', '25 Oct 2026, 01:30:00', '25 Oct 2026, 01:30:00',
    ])
    expect(EDGE.map((bad) => fmtDt(bad))).toEqual(['—', '—', '—', 'Invalid Date'])
  })
  it('a forward and a reply quote built without a zone are the Dublin text', () => {
    const message = { from_email: 'member@example.test', sent_at: '2026-07-01T08:05:00Z', subject: 'Hi', to_emails: ['desk@example.test'], text_body: 'Hello' }
    expect(forwardedHeaderLines(message)).toStrictEqual(forwardedHeaderLines(message, D))
    expect(buildForwardText({ note: 'fyi', message })).toBe(buildForwardText({ note: 'fyi', message, zone: D }))
    expect(attributionLine({ ...message, direction: 'inbound' }, {})).toBe('On Wed 1 Jul 2026 at 09:05, member@example.test wrote:')
  })
})

describe('TZ.16 America/New_York follows New York across DST', () => {
  it('a Dublin viewer sees New York wall clock plus EST/EDT; a New York viewer sees no suffix', () => {
    // 2026-03-08T07:00Z is 03:00 EDT (just after spring-forward); 06:59Z is 01:59 EST.
    expect(asOfLabel('2026-03-08T06:59:00Z', NY, D)).toBe('01:59 EST')
    expect(asOfLabel('2026-03-08T07:00:00Z', NY, D)).toBe('03:00 EDT')
    expect(asOfLabel('2026-03-08T07:00:00Z', NY, NY)).toBe('03:00')
    // Fall back: 01:30 twice.
    expect(orderCardDate('2026-11-01T05:30:00Z', NY, D)).toBe('1 Nov, 01:30 EDT')
    expect(orderCardDate('2026-11-01T06:30:00Z', NY, D)).toBe('1 Nov, 01:30 EST')
    expect(orderCardDate('2026-11-01T06:30:00Z', NY, NY)).toBe('1 Nov, 01:30')
  })
  it('the record\'s local day is New York\'s, not Dublin\'s', () => {
    // 2026-11-01T03:30Z: Sat 31 Oct 23:30 EDT in New York, Sun 1 Nov 03:30 GMT in Dublin.
    expect(nextClassLabel('2026-11-01T03:30:00Z', NY, NY)).toBe('Sat, 31 Oct')
    expect(nextClassLabel('2026-11-01T03:30:00Z', D, D)).toBe('Sun, 1 Nov')
    expect(formatDay('2026-11-01T03:30:00Z', NY, NY)).toBe('31 Oct 2026')
    expect(C.contractDay('2026-11-01T03:30:00Z', NY, NY)).toBe('31 Oct 2026')
  })
  it('every site renders 09:00 for a 09:00 New York instant, in summer (13:00Z) and winter (14:00Z)', () => {
    for (const iso of ['2026-07-01T13:00:00Z', '2026-12-01T14:00:00Z']) {
      for (const [name, next] of SITES) {
        if (name.startsWith('next-class') || name.startsWith('InvoicesManager') || name.startsWith('account contracts')) continue // date-only
        expect(next(iso, NY, NY), name).toMatch(/09:00/)
      }
    }
  })
  it('emails and the public sale copy carry the studio\'s clock with no suffix (no viewer to compare with)', () => {
    expect(forwardTimestamp('2026-11-01T05:30:00Z', NY)).toBe('Sun 1 Nov 2026, 01:30')
    expect(attributionStamp('2026-03-08T07:00:00Z', NY)).toBe('Sun 8 Mar 2026 at 03:00')
    expect(formatSaleDeadline('2026-03-09T03:59:00Z', { zone: NY })).toBe('SUNDAY 8 MARCH, 23:59')
    expect(formatSaleDeadline('2026-03-09T03:59:00Z', { zone: D })).toBe('MONDAY 9 MARCH, 03:59')
  })
  it('the host report reads in the host\'s studio zone', () => {
    expect(formatWhen('2026-09-04T10:58:14Z', NY, D)).toBe('4 Sept, 06:58 EDT')
    expect(formatWhen('2026-09-04T10:58:14Z', D, D)).toBe('4 Sept, 11:58')
  })
})
