// tz-16.tz.test.js — TZ.16 (D3 = A, D4 = A). The web display sweep: staff
// screens render each record's instant in its studio's zone, and name the zone
// only when it differs from the viewer's.
//
// Pinned against the FROZEN pre-change bodies (tz-16.legacy-dublin.test-helpers.js):
//   • Europe/Dublin record + Dublin viewer (and an unknown viewer): identical
//     text, every hour of 2026, every quarter-hour of both EU change nights, and
//     the house sample instants.
//   • America/New_York: the studio's own wall clock across both 2026 US DST
//     changes, with EST/EDT appended for a Dublin viewer and nothing for a New
//     York one.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: nothing may read the host clock
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), useSearchParams: () => new URLSearchParams() }))

const L = await import('./tz-16.legacy-dublin.test-helpers.js')
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
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
const ISOS = (() => {
  const out = [...SAMPLES]
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600_000) out.push(new Date(t).toISOString())
  for (const from of [Date.UTC(2026, 2, 28, 22), Date.UTC(2026, 9, 24, 22)]) {
    for (let t = from; t < from + 6 * 3600_000; t += 15 * 60_000) out.push(new Date(t).toISOString())
  }
  return out
})()
// Inputs the sites guard: absent, empty, unparseable.
const EDGE = [null, undefined, '', 'not-a-date']

// [name, legacy(iso), new(iso, zone, viewerZone)]
const SITES = [
  ['contracts fmtDate (team detail, team list, templates, account detail)', L.contractFmtDateLegacyDublin, C.contractStamp],
  ['account contracts list fmtDate', L.accountContractListFmtLegacyDublin, C.contractDay],
  ['contract SignatureBlock', L.contractSignedLegacyDublin, C.contractSignedStamp],
  ['AcControlPanel asOfLabel', L.acAsOfLabelLegacyDublin, asOfLabel],
  ['CalendarFeedCard stamp', L.calendarFeedStampLegacyDublin, feedStamp],
  ['next-class chip (DealCard, ContactDrawer, ContactHeaderBand)', L.nextClassLabelLegacyDublin, nextClassLabel],
  ['InvoicesManager formatDay', L.invoiceFormatDayLegacyDublin, formatDay],
  ['OfferSalesList paid time', L.offerSalesTimeLegacyDublin, paidAtLabel],
  ['OrderDetail fmtDateTime', L.orderDetailDateTimeLegacyDublin, fmtDateTime],
  ['OrdersTable row', L.orderRowDateLegacyDublin, orderRowDate],
  ['OrdersTable card', L.orderCardDateLegacyDublin, orderCardDate],
  ['ClassClimateCard class time', L.climateFmtLegacyDublin, classClimateTime],
  ['BathroomClimateCard class time', L.climateFmtLegacyDublin, bathroomClimateTime],
  ['AdsRefreshButton last synced', L.adsFmtSyncedLegacyDublin, fmtSynced],
  ['HostEmailReport formatWhen', L.hostFormatWhenLegacyDublin, formatWhen],
  ['email-forward Date header', L.forwardTimestampLegacyDublin, (iso, zone) => forwardTimestamp(iso, zone)],
  ['reply attribution stamp', L.attributionStampLegacyDublin, (iso, zone) => attributionStamp(iso, zone)],
  ['sale deadline (upper)', L.formatSaleDeadlineLegacyDublin, (iso, zone) => formatSaleDeadline(iso, { zone })],
  ['sale deadline (lower)', (iso) => L.formatSaleDeadlineLegacyDublin(iso, { uppercase: false }), (iso, zone) => formatSaleDeadline(iso, { uppercase: false, zone })],
]

// The two page-local formatters (a Next page file may export only its route
// fields), pinned by the exact call they now make.
const PAGE_SITES = [
  ['list-health dateLabel', L.listHealthDateLabelLegacyDublin, (iso, zone, viewer) => {
    if (!iso) return 'Not recorded'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'Not recorded'
    return formatRecordTime(d, zone, { day: '2-digit', month: 'short', year: 'numeric' }, 'en-IE', viewer)
  }],
  ['welcome status "updated"', (iso) => L.statusUpdatedLegacyDublin(new Date(iso)), (iso, zone) => formatRecordTime(new Date(iso), zone, { hour: '2-digit', minute: '2-digit' }, 'en-IE')],
]

describe('TZ.16 Europe/Dublin is byte-identical (Dublin record, Dublin or unknown viewer)', () => {
  it.each([...SITES, ...PAGE_SITES])('%s', (_name, legacy, next) => {
    for (const iso of ISOS) {
      const want = legacy(iso)
      expect(next(iso, D, D)).toBe(want)
      expect(next(iso, D, null)).toBe(want)
    }
  })
  it.each(SITES)('%s on absent or unparseable input', (_name, legacy, next) => {
    for (const bad of EDGE) {
      let want
      try { want = legacy(bad) } catch (e) { want = `throws ${e.constructor.name}` }
      let got
      try { got = next(bad, D, D) } catch (e) { got = `throws ${e.constructor.name}` }
      expect(got).toBe(want)
    }
  })
  it('the audit log stays on the platform zone (D4): identical, and never suffixed', () => {
    for (const iso of ISOS) expect(fmtDt(iso)).toBe(L.auditFmtDtLegacyDublin(iso))
    for (const bad of EDGE) expect(fmtDt(bad)).toBe(L.auditFmtDtLegacyDublin(bad))
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
      for (const [name, , next] of SITES) {
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
