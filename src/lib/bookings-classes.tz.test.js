// bookings-classes.tz.test.js — TZ.7: booking slots, public classes, the
// manual timetable and booking copy take the STUDIO's zone.
//
// Two halves, as every sweep: (1) Europe/Dublin is byte-identical to the
// frozen pre-change code (bookings-classes.legacy-dublin.test-helpers.js) over
// the DST-edge samples and every day/hour of 2026; (2) America/New_York follows
// New York's clock across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [] })),
}))

const LEGACY = await import('./bookings-classes.legacy-dublin.test-helpers.js')
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
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
]
const DAYS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
})()
const HOURS_2026 = (() => {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) out.push(t)
  return out
})()
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

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

describe('TZ.7 Europe/Dublin is byte-identical', () => {
  describe('booking-slots: computeAvailableSlots / computeAvailableDays', () => {
    it.each(SAMPLES)('%s', async (iso) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(iso))
      const event = eventIn(DUB)
      const nowDay = iso.slice(0, 10)
      for (const date of [addDays(nowDay, -1), nowDay, addDays(nowDay, 1), addDays(nowDay, 2), addDays(nowDay, 3)]) {
        expect(await computeAvailableSlots(emptyDb(), event, date)).toStrictEqual(await LEGACY.computeAvailableSlotsLegacyDublin(emptyDb(), event, date))
      }
      expect(await computeAvailableDays(emptyDb(), event, { days: 5 })).toStrictEqual(await LEGACY.computeAvailableDaysLegacyDublin(emptyDb(), event, { days: 5 }))
    })

    it('an event type with no location (no embed, no id) is Dublin, as before', async () => {
      const event = { ...eventIn(DUB), location_id: undefined, locations: undefined }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-01T13:30:00Z'))
      expect(await computeAvailableSlots(emptyDb(), event, '2026-07-01')).toStrictEqual(await LEGACY.computeAvailableSlotsLegacyDublin(emptyDb(), event, '2026-07-01'))
    })
  })

  it('booking-slots day labels, booking-confirmations fmtBookingTime: every day of 2026', () => {
    for (const d of DAYS_2026) {
      for (const t of ['00:30:00', '17:00:00', '', null]) expect(fmtBookingTime(d, t)).toBe(LEGACY.fmtBookingTimeLegacyDublin(d, t))
    }
    expect(fmtBookingTime('', '09:00')).toBe(LEGACY.fmtBookingTimeLegacyDublin('', '09:00'))
  })

  it('bridge-samples bookingWallClockToMs: every day of 2026 at every DST-edge time', () => {
    const times = ['00:00', '00:30', '00:59', '01:00', '01:30', '01:59', '02:00', '02:30', '06:00:30', '12:00', '23:30', '23:59:59']
    for (const d of DAYS_2026) for (const t of times) {
      expect(bookingWallClockToMs(d, t, DUB)).toBe(LEGACY.dublinWallClockToMsLegacyDublin(d, t))
    }
    for (const [d, t] of [['not-a-date', '06:00'], ['2026-06-18', '6pm'], [null, null], ['2026-06-18', '']]) {
      expect(bookingWallClockToMs(d, t, DUB)).toBeNaN()
      expect(LEGACY.dublinWallClockToMsLegacyDublin(d, t)).toBeNaN()
    }
  })

  it('class-booking-processor classLabel, manual confirm formatClassTime, public-classes shapePublicClass: every hour of 2026', () => {
    for (const ms of [...HOURS_2026, ...SAMPLES.map(Date.parse)]) {
      const iso = new Date(ms).toISOString()
      expect(classLabel(iso, DUB)).toBe(LEGACY.classLabelLegacyDublin(iso))
      expect(formatClassTime(iso, DUB)).toBe(LEGACY.formatClassTimeLegacyDublin(iso))
      const e = { _id: 'e1', name: 'S&C', time_start: ms / 1000 }
      expect(shapePublicClass(e, DUB)).toStrictEqual(LEGACY.shapePublicClassLegacyDublin(e))
    }
    for (const bad of [null, '', 'soon']) {
      expect(classLabel(bad, DUB)).toBe(LEGACY.classLabelLegacyDublin(bad))
      expect(formatClassTime(bad, DUB)).toBe(LEGACY.formatClassTimeLegacyDublin(bad))
    }
  })

  it('the defaults (no zone passed) are Dublin, as before', () => {
    const iso = '2026-07-01T18:30:00Z'
    expect(classLabel(iso)).toBe(LEGACY.classLabelLegacyDublin(iso))
    expect(formatClassTime(iso)).toBe(LEGACY.formatClassTimeLegacyDublin(iso))
    expect(shapePublicClass({ _id: 'e', time_start: Date.parse(iso) / 1000 })).toStrictEqual(LEGACY.shapePublicClassLegacyDublin({ _id: 'e', time_start: Date.parse(iso) / 1000 }))
    expect(bookingWallClockToMs('2026-07-01', '09:00')).toBe(LEGACY.dublinWallClockToMsLegacyDublin('2026-07-01', '09:00'))
    expect(classTimeLabel(iso)).toBe('7:30pm')
  })

  describe('manual-timetable manualClassOccurrences', () => {
    // TZ.17 ⚠️ (approved 11 Oct 2026) moved exactly two Dublin slots onto the
    // canonical solver: 23:xx on the spring-forward Sunday (no longer a day
    // late) and 01:xx on the fall-back Sunday (now the GMT 01:xx, like every
    // booking and shift). Pinned in src/lib/tz-17.dublin.test.js; the rest of
    // the timetable stays byte-identical to the TZ.7 freeze.
    const TZ17_MOVED = new Set(['2026-03-29|23:30', '2026-10-25|01:30'])
    const unmoved = (list) => list.filter((c) => !TZ17_MOVED.has(`${c.day}|${c.time}`))
    const { slots } = parseManualTimetable([
      'Mon-Sun 00:30 Early',
      'Mon-Sun 01:30 Edge',
      'Mon-Sun 06:15 Strength',
      'Mon-Sun 12:00 Noon',
      'Mon-Sun 18:00 Conditioning',
      'Mon-Sun 23:30 Late',
    ].join('\n'))
    it.each(SAMPLES)('%s', (iso) => {
      const now = Date.parse(iso)
      for (const args of [
        { slots, now, minNoticeHours: 0, days: 14 },
        { slots, now, minNoticeHours: 12, days: 7 },
        { slots, now, minNoticeHours: 0, days: 3, startDate: iso.slice(0, 10) },
        { slots, now, minNoticeHours: 0, days: 3, startDate: addDays(iso.slice(0, 10), 5) },
      ]) {
        expect(unmoved(manualClassOccurrences({ ...args, zone: DUB }))).toStrictEqual(unmoved(LEGACY.manualClassOccurrencesLegacyDublin(args)))
      }
    })
    it('every day of 2026 at local noon, two weeks ahead', () => {
      for (const d of DAYS_2026) {
        const now = Date.parse(`${d}T11:00:00Z`)
        const args = { slots, now, minNoticeHours: 0, days: 14 }
        expect(unmoved(manualClassOccurrences({ ...args, zone: DUB }))).toStrictEqual(unmoved(LEGACY.manualClassOccurrencesLegacyDublin(args)))
      }
    })
    it('no zone passed is Dublin', () => {
      const args = { slots, now: Date.parse('2026-10-24T23:30:00Z'), minNoticeHours: 0, days: 14 }
      expect(unmoved(manualClassOccurrences(args))).toStrictEqual(unmoved(LEGACY.manualClassOccurrencesLegacyDublin(args)))
    })
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
    // The same instants for a Dublin studio are still byte-identical to legacy.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    expect(await computeAvailableSlots(emptyDb(), dubEvent, date)).toStrictEqual(await LEGACY.computeAvailableSlotsLegacyDublin(emptyDb(), dubEvent, date))
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
    // landing_page_settings answers the timetable block.
    function studioDb({ zone = NY, zoneError = null, blocks = null } = {}) {
      const b = {
        _t: null,
        from(t) { b._t = t; return b }, select() { return b }, eq() { return b },
        maybeSingle: async () => {
          if (b._t === 'locations') return zoneError ? { data: null, error: zoneError } : { data: { id: 'NYC', timezone: zone }, error: null }
          if (b._t === 'landing_page_settings') return { data: { blocks }, error: null }
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
      const out = await readPublicClasses(studioDb({ blocks }), 'NYC', 1)
      expect(out.error).toBeNull()
      expect(out.classes.map((c) => [c.starts_at, c.day, c.time])).toEqual([['2026-07-01T13:00:00.000Z', '2026-07-01', '09:00']])
    })

    it('an unreadable zone is an error for a manual timetable, never a Dublin guess', async () => {
      noGlofox()
      const out = await readPublicClasses(studioDb({ blocks, zoneError: { message: 'boom' } }), 'NYC', 7)
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
