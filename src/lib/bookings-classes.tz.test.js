// bookings-classes.tz.test.js — TZ.7: booking slots, public classes, the
// manual timetable and booking copy take the STUDIO's zone.
//
// America/New_York follows New York's clock across both 2026 US DST changes.
// The Dublin byte-identity sweep ran in TZ.7 and was retired in TZ.18b:
// Europe/Dublin is pinned by fixed values below, and zoned-time ≡ dublin-time
// stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [] })),
}))

const { computeAvailableSlots, computeAvailableDays } = await import('./booking-slots.js')
const { fmtBookingTime } = await import('./booking-confirmations.js')
const { bookingWallClockToMs } = await import('./bridge-samples.js')
const { classLabel } = await import('./class-booking-processor.js')
const { formatClassTime } = await import('./manual-booking-confirm-copy.js')
const { shapePublicClass, readPublicClasses } = await import('./public-classes.js')
const { manualClassOccurrences, parseManualTimetable } = await import('./manual-timetable.js')
const { classTimeLabel } = await import('./class-reminders.js')
const { resetLocationZoneCache } = await import('./location-time.js')
const glofox = await import('@/lib/glofox')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
// Every bookings/blocked_times read answers empty; the slot list is then the
// availability window minus the past.
function emptyDb() {
  const chain = { from() { return chain }, select() { return chain }, eq() { return chain }, in() { return chain }, then(r) { r({ data: [] }) } }
  return chain
}
const ALL_DAY = { start: '00:00', end: '24:00' }
const everyDay = (win) => ({ sun: win, mon: win, tue: win, wed: win, thu: win, fri: win, sat: win })
const eventIn = (zone, extra = {}) => ({
  id: 'ev1', duration_minutes: 30, buffer_minutes: 0, max_advance_days: 2,
  availability: everyDay(ALL_DAY), location_id: 'L', locations: { id: 'L', timezone: zone }, ...extra,
})

afterEach(() => {
  vi.useRealTimers()
  resetLocationZoneCache()
})

describe('TZ.7 Europe/Dublin pinned values', () => {
  const at = (iso) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)) }

  it('computeAvailableSlots: Dublin\'s clock decides what is past, on both DST Sundays', async () => {
    const hourly = eventIn(DUB, { duration_minutes: 60, availability: everyDay({ start: '09:00', end: '11:00' }) })
    const both = [{ start: '09:00', end: '10:00' }, { start: '10:00', end: '11:00' }]
    const late = [{ start: '10:00', end: '11:00' }]
    at('2026-03-29T07:30:00Z') // 08:30 IST, spring-forward day
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-03-29')).toStrictEqual(both)
    at('2026-03-29T08:30:00Z') // 09:30 IST
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-03-29')).toStrictEqual(late)
    at('2026-10-25T08:30:00Z') // 08:30 GMT, fall-back day
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-10-25')).toStrictEqual(both)
    at('2026-10-25T09:30:00Z') // 09:30 GMT
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-10-25')).toStrictEqual(late)
    at('2026-07-01T08:30:00Z') // 09:30 IST
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-07-01')).toStrictEqual(late)
    at('2026-12-01T09:30:00Z') // 09:30 GMT
    expect(await computeAvailableSlots(emptyDb(), hourly, '2026-12-01')).toStrictEqual(late)
  })

  it('computeAvailableDays: "today" is the Dublin day', async () => {
    at('2026-03-28T22:30:00Z') // 22:30 GMT Sat: today still has slots
    expect(await computeAvailableDays(emptyDb(), eventIn(DUB), { days: 3 })).toStrictEqual([
      { date: '2026-03-28', label: 'Sat, 28 Mar' }, { date: '2026-03-29', label: 'Sun, 29 Mar' }, { date: '2026-03-30', label: 'Mon, 30 Mar' },
    ])
    at('2026-03-28T23:30:00Z') // 23:30 GMT Sat: the last slot is past
    expect(await computeAvailableDays(emptyDb(), eventIn(DUB), { days: 3 })).toStrictEqual([
      { date: '2026-03-29', label: 'Sun, 29 Mar' }, { date: '2026-03-30', label: 'Mon, 30 Mar' },
    ])
    at('2026-10-24T23:30:00Z') // 00:30 IST Sun 25 Oct
    expect(await computeAvailableDays(emptyDb(), eventIn(DUB), { days: 3 })).toStrictEqual([
      { date: '2026-10-25', label: 'Sun, 25 Oct' }, { date: '2026-10-26', label: 'Mon, 26 Oct' }, { date: '2026-10-27', label: 'Tue, 27 Oct' },
    ])
  })

  it('an event type with no location (no embed, no id) is Dublin', async () => {
    const event = { ...eventIn(DUB), location_id: undefined, locations: undefined }
    at('2026-07-01T13:30:00Z') // 14:30 IST
    const slots = await computeAvailableSlots(emptyDb(), event, '2026-07-01')
    expect(slots).toHaveLength(18)
    expect(slots[0]).toStrictEqual({ start: '15:00', end: '15:30' })
    expect(slots.at(-1)).toStrictEqual({ start: '23:30', end: '24:00' })
  })

  it('fmtBookingTime is the stored date and time (zone-free)', () => {
    expect(fmtBookingTime('2026-03-29', '00:30:00')).toBe('Sun, 29 Mar, 00:30')
    expect(fmtBookingTime('2026-10-25', '17:00:00')).toBe('Sun, 25 Oct, 17:00')
    expect(fmtBookingTime('2026-07-01', '')).toBe('Wed, 1 Jul')
    expect(fmtBookingTime('2026-12-31', null)).toBe('Thu, 31 Dec')
    expect(fmtBookingTime('', '09:00')).toBe('')
  })

  it('bookingWallClockToMs: Dublin wall clock across both DST changes (zone omitted = Dublin)', () => {
    const wc = (d, t) => new Date(bookingWallClockToMs(d, t, DUB)).toISOString()
    expect(wc('2026-03-29', '00:30')).toBe('2026-03-29T00:30:00.000Z') // GMT
    expect(wc('2026-03-29', '01:30')).toBe('2026-03-29T00:30:00.000Z') // the skipped hour
    expect(wc('2026-03-29', '02:30')).toBe('2026-03-29T01:30:00.000Z') // IST
    expect(wc('2026-10-25', '00:30')).toBe('2026-10-24T23:30:00.000Z') // IST
    expect(wc('2026-10-25', '01:30')).toBe('2026-10-25T01:30:00.000Z') // the repeated hour: GMT
    expect(wc('2026-10-25', '02:30')).toBe('2026-10-25T02:30:00.000Z') // GMT
    expect(wc('2026-07-01', '23:59:59')).toBe('2026-07-01T22:59:59.000Z')
    expect(wc('2026-12-01', '09:00')).toBe('2026-12-01T09:00:00.000Z')
    expect(bookingWallClockToMs('2026-07-01', '09:00')).toBe(Date.parse('2026-07-01T08:00:00Z'))
    for (const [d, t] of [['not-a-date', '06:00'], ['2026-06-18', '6pm'], [null, null], ['2026-06-18', '']]) {
      expect(bookingWallClockToMs(d, t, DUB)).toBeNaN()
    }
  })

  it('classLabel, manual confirm formatClassTime, shapePublicClass: Dublin wall clock across both DST changes', () => {
    const cases = [
      ['2026-03-29T00:59:00Z', 'Sun, 29 Mar, 00:59', 'Sunday 29 March at 00:59', '2026-03-29', 'Sun, 29 Mar', '00:59'],
      ['2026-03-29T01:00:00Z', 'Sun, 29 Mar, 02:00', 'Sunday 29 March at 02:00', '2026-03-29', 'Sun, 29 Mar', '02:00'],
      ['2026-10-25T00:30:00Z', 'Sun, 25 Oct, 01:30', 'Sunday 25 October at 01:30', '2026-10-25', 'Sun, 25 Oct', '01:30'], // IST
      ['2026-10-25T01:30:00Z', 'Sun, 25 Oct, 01:30', 'Sunday 25 October at 01:30', '2026-10-25', 'Sun, 25 Oct', '01:30'], // GMT
      ['2026-07-01T18:30:00Z', 'Wed, 1 Jul, 19:30', 'Wednesday 1 July at 19:30', '2026-07-01', 'Wed, 1 Jul', '19:30'],
      ['2026-12-31T23:30:00Z', 'Thu, 31 Dec, 23:30', 'Thursday 31 December at 23:30', '2026-12-31', 'Thu, 31 Dec', '23:30'],
    ]
    for (const [iso, label, copy, day, dayLabel, time] of cases) {
      expect(classLabel(iso, DUB)).toBe(label)
      expect(formatClassTime(iso, DUB)).toBe(copy)
      expect(shapePublicClass({ _id: 'e1', name: 'S&C', time_start: Date.parse(iso) / 1000 }, DUB)).toStrictEqual({
        event_id: 'e1', name: 'S&C', starts_at: new Date(iso).toISOString(), day, day_label: dayLabel, time,
      })
    }
    for (const bad of [null, '', 'soon']) {
      expect(classLabel(bad, DUB)).toBe('your class')
      expect(formatClassTime(bad, DUB)).toBe('')
    }
  })

  it('the defaults (no zone passed) are Dublin', () => {
    const iso = '2026-07-01T18:30:00Z'
    expect(classLabel(iso)).toBe('Wed, 1 Jul, 19:30')
    expect(formatClassTime(iso)).toBe('Wednesday 1 July at 19:30')
    expect(shapePublicClass({ _id: 'e', time_start: Date.parse(iso) / 1000 })).toMatchObject({ day: '2026-07-01', time: '19:30' })
    expect(classTimeLabel(iso)).toBe('7:30pm')
  })

  it('manualClassOccurrences: a 09:00 class follows Dublin across both DST weekends (zone omitted = Dublin)', () => {
    // The two slots TZ.17 moved (23:xx spring-forward Sunday, 01:xx fall-back
    // Sunday) are pinned in src/lib/tz-17.dublin.test.js.
    const { slots } = parseManualTimetable('Mon-Sun 09:00 Strength')
    const starts = (now, zone) => manualClassOccurrences({ slots, now: Date.parse(now), minNoticeHours: 0, days: 3, ...(zone ? { zone } : {}) })
    expect(starts('2026-03-28T05:00:00Z', DUB).map((c) => [c.starts_at, c.day, c.day_label, c.time])).toEqual([
      ['2026-03-28T09:00:00.000Z', '2026-03-28', 'Sat, 28 Mar', '09:00'], // GMT
      ['2026-03-29T08:00:00.000Z', '2026-03-29', 'Sun, 29 Mar', '09:00'], // IST
      ['2026-03-30T08:00:00.000Z', '2026-03-30', 'Mon, 30 Mar', '09:00'],
    ])
    expect(starts('2026-10-24T05:00:00Z', DUB).map((c) => c.starts_at)).toEqual([
      '2026-10-24T08:00:00.000Z', '2026-10-25T09:00:00.000Z', '2026-10-26T09:00:00.000Z',
    ])
    expect(starts('2026-10-24T05:00:00Z')).toStrictEqual(starts('2026-10-24T05:00:00Z', DUB))
    expect(starts('2026-10-24T05:00:00Z', DUB)[0].event_id).toBe('manual-20261024-0900-strength')
    const notice = parseManualTimetable('Mon-Sun 00:30 Early\nMon-Sun 18:00 Conditioning').slots
    // 13:00 IST with 12h notice over two days: only Thursday's 18:00 is far enough out.
    expect(manualClassOccurrences({ slots: notice, now: Date.parse('2026-07-01T12:00:00Z'), minNoticeHours: 12, days: 2, zone: DUB })
      .map((c) => [c.starts_at, c.time])).toEqual([['2026-07-02T17:00:00.000Z', '18:00']])
  })
})

describe('TZ.7 America/New_York follows New York across DST', () => {
  // Wed 1 Jul 2026 (EDT, UTC-4) and Tue 1 Dec 2026 (EST, UTC-5): availability
  // 09:00-11:00 in hour slots, i.e. a 09:00 and a 10:00 slot.
  const WIN = { start: '09:00', end: '11:00' }
  const nyEvent = eventIn(NY, { duration_minutes: 60, availability: everyDay(WIN) })
  const dubEvent = eventIn(DUB, { duration_minutes: 60, availability: everyDay(WIN) })

  it.each([
    ['summer (EDT)', '2026-07-01T13:30:00Z', '2026-07-01'],
    ['winter (EST)', '2026-12-01T14:30:00Z', '2026-12-01'],
  ])('%s: at 09:30 New York the 09:00 slot is past and the 10:00 slot is open', async (_label, iso, date) => {
    const nowMs = Date.parse(iso)
    expect(await computeAvailableSlots(emptyDb(), nyEvent, date, { nowMs })).toEqual([{ start: '10:00', end: '11:00' }])
    // The same instants are 14:30 in Dublin: both slots are past there.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    expect(await computeAvailableSlots(emptyDb(), dubEvent, date)).toStrictEqual([])
  })

  it('the bookable "today" flips at New York midnight, not Dublin midnight', async () => {
    // 04:30Z on 8 Mar is 23:30 on Sat 7 Mar in New York (EST) but 04:30 on 8 Mar in Dublin.
    const nowMs = Date.parse('2026-03-08T04:30:00Z')
    const late = eventIn(NY, { duration_minutes: 15, availability: everyDay({ start: '23:00', end: '24:00' }) })
    expect((await computeAvailableSlots(emptyDb(), late, '2026-03-07', { nowMs })).map((s) => s.start)).toEqual(['23:45'])
    const lateDublin = { ...late, locations: { id: 'D', timezone: DUB } }
    expect(await computeAvailableSlots(emptyDb(), lateDublin, '2026-03-07', { nowMs })).toEqual([])
    const days = await computeAvailableDays(emptyDb(), late, { days: 3, nowMs })
    expect(days.map((d) => d.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
    expect(days[0].label).toBe('Sat, 7 Mar')
  })

  it('reads the event type\'s zone from its location when the select carried no embed', async () => {
    const reads = []
    const db = {
      from(t) { reads.push(t); return db }, select() { return db }, eq() { return db }, in() { return db },
      maybeSingle: async () => ({ data: { id: 'L', timezone: NY }, error: null }),
      then(r) { r({ data: [] }) },
    }
    const { locations: _drop, ...noEmbed } = nyEvent
    expect(await computeAvailableSlots(db, noEmbed, '2026-07-01', { nowMs: Date.parse('2026-07-01T13:30:00Z') })).toEqual([{ start: '10:00', end: '11:00' }])
    expect(reads).toContain('locations')
  })

  it('a failed zone read fails the slot lookup (never a guessed clock)', async () => {
    const db = {
      from() { return db }, select() { return db }, eq() { return db }, in() { return db },
      maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
      then(r) { r({ data: [] }) },
    }
    const { locations: _drop, ...noEmbed } = nyEvent
    await expect(computeAvailableSlots(db, noEmbed, '2026-07-01')).rejects.toThrow(/locations\.timezone unreadable/)
  })

  it('a booking wall clock is 13:00Z at 09:00 EDT and 14:00Z at 09:00 EST', () => {
    expect(bookingWallClockToMs('2026-07-01', '09:00', NY)).toBe(Date.parse('2026-07-01T13:00:00Z'))
    expect(bookingWallClockToMs('2026-12-01', '09:00', NY)).toBe(Date.parse('2026-12-01T14:00:00Z'))
    expect(bookingWallClockToMs('2026-03-08', '09:00', NY)).toBe(Date.parse('2026-03-08T13:00:00Z')) // spring-forward day
    expect(bookingWallClockToMs('2026-11-01', '09:00', NY)).toBe(Date.parse('2026-11-01T14:00:00Z')) // fall-back day
  })

  it('labels a Glofox instant on New York\'s clock without re-zoning the instant', () => {
    // 04:30Z on 8 Mar = 23:30 Sat 7 Mar EST; 05:30Z on 1 Nov = 01:30 EDT (before fall-back).
    const sat = shapePublicClass({ _id: 'g1', name: 'Late', time_start: Date.parse('2026-03-08T04:30:00Z') / 1000 }, NY)
    expect(sat).toStrictEqual({ event_id: 'g1', name: 'Late', starts_at: '2026-03-08T04:30:00.000Z', day: '2026-03-07', day_label: 'Sat, 7 Mar', time: '23:30' })
    const fb = shapePublicClass({ _id: 'g2', name: 'Early', time_start: Date.parse('2026-11-01T05:30:00Z') / 1000 }, NY)
    expect(fb).toMatchObject({ starts_at: '2026-11-01T05:30:00.000Z', day: '2026-11-01', time: '01:30' })
    expect(classLabel('2026-07-01T13:00:00Z', NY)).toBe('Wed, 1 Jul, 09:00')
    expect(classLabel('2026-12-01T14:00:00Z', NY)).toBe('Tue, 1 Dec, 09:00')
    expect(formatClassTime('2026-07-01T13:00:00Z', NY)).toBe('Wednesday 1 July at 09:00')
    expect(formatClassTime('2026-12-01T14:00:00Z', NY)).toBe('Tuesday 1 December at 09:00')
  })

  it('a booking date label is the stored date in any zone (zone-free)', () => {
    expect(fmtBookingTime('2026-03-08', '09:00:00')).toBe('Sun, 8 Mar, 09:00')
    expect(fmtBookingTime('2026-11-01', '23:30:00')).toBe('Sun, 1 Nov, 23:30')
  })

  describe('manual timetable', () => {
    const { slots } = parseManualTimetable('Mon-Sun 09:00 Strength')
    it('a 09:00 class is 13:00Z in summer and 14:00Z in winter, across both US clock changes', () => {
      const at = (now, days = 3) => manualClassOccurrences({ slots, now: Date.parse(now), minNoticeHours: 0, days, zone: NY })
      expect(at('2026-07-01T04:00:00Z', 1).map((c) => c.starts_at)).toEqual(['2026-07-01T13:00:00.000Z'])
      expect(at('2026-12-01T05:00:00Z', 1).map((c) => c.starts_at)).toEqual(['2026-12-01T14:00:00.000Z'])
      // Sat 7 → Mon 9 Mar: EST, then EDT from the 8th.
      expect(at('2026-03-07T05:00:00Z').map((c) => c.starts_at)).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z'])
      // Sat 31 Oct → Mon 2 Nov: EDT, then EST from the 1st.
      expect(at('2026-10-31T04:00:00Z').map((c) => c.starts_at)).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'])
    })
    it('the window starts on New York\'s today and labels days on New York\'s clock', () => {
      // 03:30Z on Thu 2 Jul is still Wed 1 Jul in New York.
      const out = manualClassOccurrences({ slots, now: Date.parse('2026-07-02T03:30:00Z'), minNoticeHours: 0, days: 1, zone: NY })
      expect(out).toEqual([])
      const two = manualClassOccurrences({ slots, now: Date.parse('2026-07-02T03:30:00Z'), minNoticeHours: 0, days: 2, zone: NY })
      expect(two.map((c) => [c.day, c.day_label, c.time])).toEqual([['2026-07-02', 'Thu, 2 Jul', '09:00']])
    })
  })

  describe('readPublicClasses uses the location\'s zone', () => {
    // A tolerant db: locations answers the studio's zone (or fails),
    // The timetable block comes in through the `blocks` option (the resolved
    // page's merged blocks), so no landing read is stubbed here.
    // HATCHSTART.1: the membership-source read (not a un1t.online studio
    // here) is a different select on locations and never fails.
    function studioDb({ zone = NY, zoneError = null } = {}) {
      const b = {
        _t: null,
        _cols: null,
        from(t) { b._t = t; return b }, select(c) { b._cols = c; return b }, eq() { return b },
        maybeSingle: async () => {
          if (b._t === 'locations' && b._cols === 'membership_source, settings') return { data: { membership_source: 'none', settings: {} }, error: null }
          if (b._t === 'locations') return zoneError ? { data: null, error: zoneError } : { data: { id: 'NYC', timezone: zone }, error: null }
          return { data: null, error: null }
        },
      }
      return b
    }
    const blocks = [{ type: 'class_funnel', timetable: 'Mon-Sun 09:00 Strength', min_notice_hours: 0 }]
    const noGlofox = () => {
      glofox.glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
      glofox.missingGlofoxCredentialsForLocation.mockReturnValueOnce(['Branch ID', 'API Key', 'API Token'])
    }

    it('a manual timetable is New York wall clock', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-01T04:00:00Z'))
      noGlofox()
      const out = await readPublicClasses(studioDb(), 'NYC', 1, { blocks })
      expect(out.error).toBeNull()
      expect(out.classes.map((c) => [c.starts_at, c.day, c.time])).toEqual([['2026-07-01T13:00:00.000Z', '2026-07-01', '09:00']])
    })

    it('an unreadable zone is an error for a manual timetable, never a Dublin guess', async () => {
      noGlofox()
      const out = await readPublicClasses(studioDb({ zoneError: { message: 'boom' } }), 'NYC', 7, { blocks })
      expect(out).toEqual({ classes: [], error: 'location_zone_unreadable' })
    })

    it('Glofox classes are labelled in the studio zone; an unreadable zone only falls back the label', async () => {
      const t = Date.parse('2026-03-08T04:30:00Z') / 1000
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-03-01T00:00:00Z'))
      glofox.fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [{ _id: 'g1', name: 'Late', time_start: t, size: 10, booked: 1 }] })
      const ny = await readPublicClasses(studioDb(), 'NYC', 7)
      expect(ny.classes.map((c) => [c.day, c.time])).toEqual([['2026-03-07', '23:30']])
      resetLocationZoneCache()
      glofox.fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [{ _id: 'g1', name: 'Late', time_start: t, size: 10, booked: 1 }] })
      const fallback = await readPublicClasses(studioDb({ zoneError: { message: 'boom' } }), 'NYC', 7)
      expect(fallback.error).toBeNull()
      expect(fallback.classes.map((c) => [c.day, c.time])).toEqual([['2026-03-08', '04:30']])
    })
  })
})
