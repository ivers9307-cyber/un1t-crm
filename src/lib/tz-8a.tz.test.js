// tz-8a.tz.test.js — TZ.8a: rostering, shifts, swaps, availability and staff
// push decisions take EACH STUDIO's zone (locations.timezone).
//
// Two halves: (1) Europe/Dublin, pinned by fixed values around both 2026 EU
// DST changes (TZ.8a's byte-identity sweep against a frozen copy of the
// pre-change code was retired in TZ.18b; zoned-time ≡ dublin-time stays
// proven by shared/zoned-time.parity.test.js); (2) America/New_York follows
// New York's clock across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const WT = await import('@shared/working-time')
const { buildCandidates } = await import('@shared/candidates')
const { staffWallClockHHMM, inStaffPushHours, resolveStaffTimeZone } = await import('./staff-push-hours.js')
const { blockEditNoticeWhen, coachShiftOver } = await import('./block-edit.js')
const { planTimeChangeNotices } = await import('./block-edit-notify.js')
const { stampMeansTold, rosterChangeTold, rosterChangeByline } = await import('./roster-change-format.js')
const { publishedLabel, missingSnapshotMessage } = await import('./roster-compare-format.js')
const { buildShiftReminderMessage, reminderPlanFor, runShiftReminders } = await import('./shift-reminders.js')
const { fetchStaffingGapsThisWeek } = await import('./roster-staffing.js')
const { fetchRosterRunways } = await import('./roster-runway-data.js')
const { supersedeEmptyTrimmedRosters } = await import('./roster-publish.js')
const { resetLocationZoneCache, todayStrIn } = await import('./location-time.js')

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
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const at = (iso) => Date.parse(iso)

afterEach(() => {
  vi.useRealTimers()
  resetLocationZoneCache()
})

// A recording PostgREST stand-in: every query's filters are kept, every
// table answers from `tables` (rows, or a function of the recorded query).
function recDb(tables = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, select: null, in: [], gte: [], lte: [], eq: [] }
      queries.push(q)
      const answer = () => {
        const t = tables[table]
        if (t === undefined) return { data: [], error: null }
        return typeof t === 'function' ? t(q) : { data: t, error: null }
      }
      const chain = {
        select(s) { q.select = s; return chain },
        in(c, v) { q.in.push([c, v]); return chain },
        gte(c, v) { q.gte.push([c, v]); return chain },
        lte(c, v) { q.lte.push([c, v]); return chain },
        eq(c, v) { q.eq.push([c, v]); return chain },
        is() { return chain },
        order() { return chain },
        range() { return chain },
        limit() { return chain },
        maybeSingle() { return Promise.resolve(answer()) },
        then(res, rej) { return Promise.resolve(answer()).then(res, rej) },
      }
      return chain
    },
  }
}

// ── shared/working-time.js ────────────────────────────────────────────────
const shift = (over = {}) => ({
  profile_id: 'p1', block_id: 'b1', block_date: '2026-03-29', location_id: 'L', location_name: 'Studio',
  name: 'Class', status: 'scheduled', start_time: '09:00:00', end_time: '10:00:00', ...over,
})

describe('TZ.8a Europe/Dublin pinned values', () => {
  const iso = (ms) => new Date(ms).toISOString()

  it.each([
    // [block_date, start, end, start instant, end instant]
    ['2026-01-15', '09:00:00', '10:00:00', '2026-01-15T09:00:00.000Z', '2026-01-15T10:00:00.000Z'], // winter (GMT)
    ['2026-07-15', '09:00:00', '10:00:00', '2026-07-15T08:00:00.000Z', '2026-07-15T09:00:00.000Z'], // summer (IST)
    ['2026-03-28', '22:00:00', '24:00:00', '2026-03-28T22:00:00.000Z', '2026-03-29T00:00:00.000Z'], // 24:00 end, eve of spring-forward
    ['2026-10-24', '20:00:30', '24:00:00', '2026-10-24T19:00:30.000Z', '2026-10-24T23:00:00.000Z'], // seconds kept
    ['2026-03-29', '01:30:00', '02:30:00', '2026-03-29T01:30:00.000Z', '2026-03-29T01:30:00.000Z'], // the skipped hour: zero length
    ['2026-10-25', '01:30:00', '01:45:00', '2026-10-25T01:30:00.000Z', '2026-10-25T01:45:00.000Z'], // the repeated hour: the second (GMT)
    ['2026-02-30', '09:00:00', '10:00:00', '2026-03-02T09:00:00.000Z', '2026-03-02T10:00:00.000Z'], // rolls over, as before
    ['2026-06-01', '22:00:00', '06:00:00', '2026-06-01T21:00:00.000Z', '2026-06-02T05:00:00.000Z'], // overnight (defence)
  ])('workingWindow %s %s-%s (no zone, and zone Europe/Dublin)', (date, start, end, startIso, endIso) => {
    const row = shift({ block_date: date, start_time: start, end_time: end })
    for (const w of [WT.workingWindow(row), WT.workingWindow({ ...row, timezone: DUB })]) {
      expect([iso(w.startMs), iso(w.endMs)]).toEqual([startIso, endIso])
    }
  })

  // A week of a coach's shifts (06:00-13:30 and 17:00-22:30 daily) around each Dublin DST change.
  const weekAround = (monday) => Array.from({ length: 7 }, (_, i) => [
    shift({ block_id: `${monday}-${i}-a`, block_date: addDays(monday, i), start_time: '06:00:00', end_time: '13:30:00' }),
    shift({ block_id: `${monday}-${i}-b`, block_date: addDays(monday, i), start_time: '17:00:00', end_time: '22:30:00' }),
  ]).flat()
  it.each([
    // [monday, the six nightly rests (minutes), the candidate's rest before a 05:00 Sunday start]
    ['2026-03-23', [450, 450, 450, 450, 450, 390], 330], // Sat→Sun night loses the spring-forward hour
    ['2026-10-19', [450, 450, 450, 450, 450, 510], 450], // ...and gains the fall-back hour
    ['2026-06-29', [450, 450, 450, 450, 450, 450], 390],
  ])('rest gaps, long weeks and the publish advisories: week of %s', (monday, rests, candRest) => {
    const shifts = weekAround(monday)
    const people = new Map([['p1', { full_name: 'Coach A', employment_type: 'fte' }]])
    expect(WT.restGapViolations(shifts).map((v) => v.rest_minutes)).toEqual(rests)
    // Per shift, each day's 13:30 → 17:00 break (210 min) counts too.
    expect(WT.restGapViolations(shifts, { restScope: 'shift' }).map((v) => v.rest_minutes)).toEqual([...rests.flatMap((r) => [210, r]), 210])
    expect(WT.weekHoursOver(shifts).map((w) => [w.week_start, w.minutes, w.shift_count])).toEqual([[monday, 5460, 14]])
    const adv = WT.workingTimeAdvisories(shifts, { people, hereLocationId: 'L', from: monday, to: addDays(monday, 6), todayIso: monday })
    expect(adv.restGaps.map((g) => g.rest_minutes)).toEqual(rests)
    expect(adv.longWeeks.map((w) => w.minutes)).toEqual([5460])
    const cand = shift({ profile_id: 'p1', block_id: 'new', block_date: addDays(monday, 6), start_time: '05:00:00', end_time: '09:00:00' })
    const cwt = WT.candidateWorkingTime(shifts, cand)
    expect(cwt.restGap.rest_minutes).toBe(candRest)
    expect(cwt.weekHours).toEqual({ week_start: monday, minutes: 5700 })
  })

  it.each([
    // [date, Coach A's rest after a 20:00-24:00 shift the night before, its wording]
    ['2026-03-29', 360, 'Only 6h rest · 6h this week'], // 00:00 → 07:00 IST is 6 real hours
    ['2026-10-25', 480, 'Only 8h rest · 6h this week'], // 00:00 IST → 07:00 GMT is 8
    ['2026-07-15', 420, 'Only 7h rest · 6h this week'],
  ])('buildCandidates: a 07:00-09:00 block on %s', (date, rest, reason) => {
    const block = {
      id: 'blk', location_id: 'L', block_date: date, start_time: '07:00:00', end_time: '09:00:00',
      shift_templates: { name: 'Early' }, shift_assignments: [],
    }
    const members = [{ profile_id: 'p1', full_name: 'Coach A', employment_type: 'fte' }, { profile_id: 'p2', full_name: 'Coach B', employment_type: 'contractor' }]
    const shifts = [
      shift({ profile_id: 'p1', block_id: 'x', block_date: addDays(date, -1), start_time: '20:00:00', end_time: '24:00:00' }),
      shift({ profile_id: 'p1', block_id: 'y', block_date: date, start_time: '10:00:00', end_time: '12:00:00' }),
      shift({ profile_id: 'p2', block_id: 'z', block_date: date, start_time: '06:00:00', end_time: '07:30:00' }),
    ]
    const args = { block, members, shifts, checked: { shifts: true, cross_studio: true, leave: true, availability: true } }
    // The studio zone on the block (Dublin) changes nothing.
    for (const out of [buildCandidates(args), buildCandidates({ ...args, block: { ...block, locations: { timezone: DUB } } })]) {
      const [a, b] = out.candidates
      expect([a.profile_id, a.free, a.tier, a.rest_gap.rest_minutes, a.reason]).toEqual(['p1', true, 'advisory', rest, reason])
      expect([b.profile_id, b.free, b.tier, b.reason]).toEqual(['p2', false, 'blocked', 'Working 6am–7:30am Class · 1h 30m this week'])
    }
  })

  it.each([
    // [instant, Dublin 'HH:MM', inside 07:00-22:00]
    ['2026-01-15T06:59:00Z', '06:59', false], ['2026-01-15T07:00:00Z', '07:00', true],
    ['2026-01-15T21:59:00Z', '21:59', true], ['2026-01-15T22:00:00Z', '22:00', false],
    ['2026-07-01T05:59:00Z', '06:59', false], ['2026-07-01T06:00:00Z', '07:00', true],
    ['2026-07-01T21:00:00Z', '22:00', false],
    ['2026-03-29T01:00:00Z', '02:00', false], ['2026-10-25T01:00:00Z', '01:00', false],
  ])('staff quiet hours at %s: Dublin, and every unusable zone falls back to Dublin', (at_, hhmm, inBand) => {
    for (const tz of [DUB, null, undefined, 'Mars/Olympus', '']) {
      expect(staffWallClockHHMM(at(at_), tz)).toBe(hhmm)
      expect(inStaffPushHours(at(at_), tz)).toBe(inBand)
    }
  })

  it('resolveStaffTimeZone', () => {
    for (const tz of [DUB, null, undefined]) expect(resolveStaffTimeZone(tz)).toStrictEqual({ timeZone: DUB, warn: false })
    for (const tz of ['Mars/Olympus', '', '   ', 42]) expect(resolveStaffTimeZone(tz)).toStrictEqual({ timeZone: DUB, warn: true })
    expect(resolveStaffTimeZone(NY)).toStrictEqual({ timeZone: NY, warn: false })
  })

  it('block edits: the notice day and "shift over" on both DST nights and a summer morning', () => {
    const windows = [{ from: { start_time: '07:10:00', end_time: '08:00:00' }, to: { start_time: '07:20:00', end_time: '08:30:00' } }]
    for (const [nowIso, today, expected] of [
      // per block date (yesterday, today, tomorrow): [notice, shift over]
      ['2026-03-29T00:30:00Z', '2026-03-29', [['morning', true], ['too_late', false], ['morning', false]]], // quiet night
      ['2026-10-25T00:30:00Z', '2026-10-25', [['morning', true], ['too_late', false], ['morning', false]]],
      ['2026-07-01T06:30:00Z', '2026-07-01', [['shortly', true], ['shortly', false], ['shortly', false]]], // 07:30 IST, shift not over
      ['2026-07-01T07:31:00Z', '2026-07-01', [['shortly', true], ['shortly', true], ['shortly', false]]], // 08:31 IST, over
    ]) {
      const nowMs = at(nowIso)
      expect(todayStrIn(DUB, nowMs)).toBe(today)
      ;[addDays(today, -1), today, addDays(today, 1)].forEach((blockDate, i) => {
        for (const timeZone of [DUB, null]) {
          expect(blockEditNoticeWhen({ nowMs, timeZone, blockDate, windows })).toBe(expected[i][0])
          expect(coachShiftOver({ blockDate, from: windows[0].from, to: windows[0].to, nowMs, timeZone })).toBe(expected[i][1])
        }
      })
    }
  })

  it.each([
    // [notified - 5 min, told, byline (created 3h before)]
    ['2026-01-15T12:00:00Z', 'told 12:05', 'Mgr · 15 Jan 09:00'],
    ['2026-07-01T23:00:00Z', 'told 2 Jul 00:05', 'Mgr · 1 Jul 21:00'], // past Dublin midnight
    ['2026-03-29T01:00:00Z', 'told 29 Mar 02:05', 'Mgr · 28 Mar 22:00'],
    ['2026-10-25T01:30:00Z', 'told 25 Oct 01:35', 'Mgr · 24 Oct 23:30'],
  ])('the change-log drawer at %s', (nowIso, told, byline) => {
    const ms = at(nowIso)
    const c = { action: 'assigned', details: {}, block_date: todayStrIn(DUB, ms), created_at: new Date(ms - 3 * 3_600_000).toISOString(), notified_at: new Date(ms + 5 * 60_000).toISOString(), actor_name: 'Mgr' }
    for (const zone of [DUB, null, undefined]) {
      expect(stampMeansTold(c, zone)).toBe(true)
      expect(rosterChangeTold(c, zone)).toBe(told)
      expect(rosterChangeByline(c, zone)).toBe(byline)
    }
  })

  it.each([
    ['2026-01-15T12:00:00Z', 'Thu 15 Jan, 12:00'],
    ['2026-07-01T23:00:00Z', 'Thu 2 Jul, 00:00'],
    ['2026-03-29T01:00:00Z', 'Sun 29 Mar, 02:00'],
    ['2026-10-25T00:30:00Z', 'Sun 25 Oct, 01:30'], // first 01:30 (IST)
    ['2026-10-25T01:30:00Z', 'Sun 25 Oct, 01:30'], // second 01:30 (GMT)
  ])('"Published vs now": the publish label and the before-snapshots message at %s', (publishedIso, label) => {
    expect(publishedLabel(publishedIso)).toBe(label)
    expect(publishedLabel(publishedIso, DUB)).toBe(label)
    expect(missingSnapshotMessage({ missing_reason: 'before_snapshots', snapshots_began_at: publishedIso, timezone: DUB }))
      .toBe(`Published vs now is available for rosters published from ${label.split(',')[0]}. This roster was published before then.`)
  })

  it.each([
    ['2026-03-28T23:30:00Z', '2026-03-28'], // eve of spring-forward
    ['2026-10-24T23:30:00Z', '2026-10-25'], // 00:30 IST, the fall-back night
    ['2026-07-01T12:00:00Z', '2026-07-01'],
  ])('the shift reminder\'s today/tomorrow wording at %s', (nowIso, today) => {
    const nowMs = at(nowIso)
    const wording = [
      ['Shift today at 06:00', 'Today 06:00 to 08:00 at North: Early · with Bo'],
      ['Shift tomorrow at 06:00', 'Tomorrow 06:00 to 08:00 at North: Early · with Bo'],
      [`Shift on ${addDays(today, 2)} at 06:00`, `On ${addDays(today, 2)} 06:00 to 08:00 at North: Early · with Bo`],
    ]
    ;[today, addDays(today, 1), addDays(today, 2)].forEach((date, i) => {
      const run = [{ id: 'a', profile_id: 'p', location_id: 'L', shift_date: date, block_start_time: '06:00:00', block_end_time: '08:00:00', shift_templates: { name: 'Early' } }]
      const args = { run, nameByLocation: { L: 'North' }, coNames: ['Bo'], nowMs }
      const [title, body] = wording[i]
      expect(buildShiftReminderMessage({ ...args, zone: DUB })).toStrictEqual({ title, body })
      expect(buildShiftReminderMessage(args)).toStrictEqual({ title, body })
    })
  })

  it.each(SAMPLES)('the Today chip reads and counts on the Dublin day at %s', async (iso) => {
    const nowMs = at(iso)
    const blocks = (q) => ({ data: [
      { id: 'b1', location_id: 'L', block_date: todayStrIn(DUB, nowMs), start_time: '23:00:00', min_coaches: 1, shift_templates: { kind: 'class' }, shift_assignments: [] },
      { id: 'b2', location_id: 'L', block_date: addDays(todayStrIn(DUB, nowMs), 1), start_time: '09:00:00', min_coaches: 1, shift_templates: { kind: 'class' }, shift_assignments: [] },
    ].filter((b) => b.block_date >= q.gte[0][1] && b.block_date <= q.lte[0][1]), error: null })
    const zoned = recDb({ shift_blocks: blocks })
    const pinned = recDb({ shift_blocks: blocks })
    const a = await fetchStaffingGapsThisWeek(zoned, ['L'], { zones: new Map([['L', DUB]]), nowMs })
    const b = await fetchStaffingGapsThisWeek(pinned, ['L'], { todayIso: todayStrIn(DUB, nowMs) })
    expect(a).toStrictEqual(b)
    expect(zoned.queries[0].gte).toStrictEqual(pinned.queries[0].gte)
    expect(zoned.queries[0].lte).toStrictEqual(pinned.queries[0].lte)
  })

  it.each(SAMPLES)('the roster runway reads and judges on the Dublin day at %s', async (iso) => {
    const nowMs = at(iso)
    const tables = {
      shift_templates: [{ id: 't', location_id: 'L', days_of_week: ['mon'], kind: 'class' }],
      shift_blocks: (q) => ({ data: [7, 8, 9, 10, 14, 15].map((n) => ({
        id: `b${n}`, location_id: 'L', block_date: addDays(todayStrIn(DUB, nowMs), n), min_coaches: 1,
        shift_templates: { kind: 'class' }, rosters: { status: 'draft' }, shift_assignments: [],
      })).filter((b) => b.block_date >= q.gte[0][1] && b.block_date <= q.lte[0][1]), error: null }),
    }
    const zoned = recDb(tables)
    const pinned = recDb(tables)
    const a = await fetchRosterRunways(zoned, ['L'], { zones: { L: DUB }, nowMs })
    const b = await fetchRosterRunways(pinned, ['L'], { todayIso: todayStrIn(DUB, nowMs) })
    expect(a).toStrictEqual(b)
    expect(zoned.queries[1].gte).toStrictEqual(pinned.queries[1].gte)
    expect(zoned.queries[1].lte).toStrictEqual(pinned.queries[1].lte)
  })
})

describe('TZ.8a America/New_York follows New York across DST', () => {
  it('a 09:00 wall clock is 13:00Z in summer and 14:00Z in winter (and Dublin stays Dublin)', () => {
    expect(WT.workingWindow(shift({ block_date: '2026-07-01', timezone: NY })).startMs).toBe(at('2026-07-01T13:00:00Z'))
    expect(WT.workingWindow(shift({ block_date: '2026-12-01', timezone: NY })).startMs).toBe(at('2026-12-01T14:00:00Z'))
    expect(WT.workingWindow(shift({ block_date: '2026-07-01' }), NY).startMs).toBe(at('2026-07-01T13:00:00Z'))
    expect(WT.workingWindow(shift({ block_date: '2026-07-01', timezone: DUB })).startMs).toBe(at('2026-07-01T08:00:00Z'))
  })

  it('rest is elapsed time on each studio\'s own clock: the fall-back night is an hour longer, spring-forward an hour shorter', () => {
    // 22:00 → 07:30 is a 9h30 wall gap.
    const night = (d1, d2) => [
      shift({ block_id: 'eve', block_date: d1, start_time: '18:00:00', end_time: '22:00:00', timezone: NY }),
      shift({ block_id: 'mor', block_date: d2, start_time: '07:30:00', end_time: '12:00:00', timezone: NY }),
    ]
    expect(WT.restGapViolations(night('2026-10-31', '2026-11-01'))[0].rest_minutes).toBe(630) // 10h30 real: the repeated hour
    expect(WT.restGapViolations(night('2026-03-07', '2026-03-08'))[0].rest_minutes).toBe(510) // 8h30 real: the skipped hour
    // Read as Dublin wall clock those nights are ordinary 9h30 gaps.
    const asDublin = (rows) => rows.map((r) => ({ ...r, timezone: DUB }))
    expect(WT.restGapViolations(asDublin(night('2026-10-31', '2026-11-01')))[0].rest_minutes).toBe(570)
    // A week's hours count the repeated hour too: 21:00-03:00 across the fall-back night is 7 real hours.
    const long = shift({ block_id: 'n', block_date: '2026-10-31', start_time: '21:00:00', end_time: '03:00:00', timezone: NY })
    const w = WT.workingWindow(long)
    expect((w.endMs - w.startMs) / 3_600_000).toBe(7)
  })

  it('a cross-studio rest converts each side with its own zone', () => {
    // Dublin 06:00-10:00 IST (05:00-09:00Z), then New York 08:00 EDT (12:00Z) the same day:
    // 3 hours of real rest, though the wall clocks read 10:00 → 08:00.
    const rows = [
      shift({ block_id: 'dub', block_date: '2026-07-01', location_id: 'D', start_time: '06:00:00', end_time: '10:00:00', timezone: DUB }),
      shift({ block_id: 'ny', block_date: '2026-07-02', location_id: 'N', start_time: '08:00:00', end_time: '09:00:00', timezone: NY }),
    ]
    // Next working day (2 Jul) starts 2 Jul 12:00Z; the 1 Jul shift ended 1 Jul 09:00Z: 27h, no violation.
    expect(WT.restGapViolations(rows)).toEqual([])
    const tight = [rows[0], { ...rows[1], block_date: '2026-07-01', block_id: 'ny2' }]
    expect(WT.restGapViolations(tight, { restScope: 'shift' })[0].rest_minutes).toBe(180)
  })

  it('candidates read the target on the block\'s studio clock: a NY coach busy 09:00-10:00 EDT clashes with a NY 09:30 shift', () => {
    const block = {
      id: 'blk', location_id: 'N', block_date: '2026-07-01', start_time: '09:30:00', end_time: '10:30:00',
      shift_templates: { name: 'Mid' }, shift_assignments: [], locations: { timezone: NY },
    }
    const members = [{ profile_id: 'p1', full_name: 'Coach A', employment_type: 'fte' }]
    const shifts = [shift({ profile_id: 'p1', block_id: 'x', block_date: '2026-07-01', location_id: 'N', start_time: '09:00:00', end_time: '10:00:00', timezone: NY })]
    const [c] = buildCandidates({ block, members, shifts, checked: { shifts: true, cross_studio: true } }).candidates
    expect(c.free).toBe(false)
    // Without the zone on the target (the old Dublin read) the same pair looked free.
    const [old] = buildCandidates({ block: { ...block, locations: undefined }, members, shifts, checked: { shifts: true, cross_studio: true } }).candidates
    expect(old.free).toBe(true)
  })

  it('staff quiet hours are New York\'s 07:00-22:00, across both US changes', () => {
    expect(inStaffPushHours(at('2026-03-08T11:00:00Z'), NY)).toBe(true) // 07:00 EDT
    expect(inStaffPushHours(at('2026-03-08T10:59:00Z'), NY)).toBe(false) // 06:59 EDT
    expect(inStaffPushHours(at('2026-11-01T12:00:00Z'), NY)).toBe(true) // 07:00 EST
    expect(inStaffPushHours(at('2026-11-01T11:59:00Z'), NY)).toBe(false) // 06:59 EST
    expect(staffWallClockHHMM(at('2026-11-01T06:30:00Z'), NY)).toBe('01:30') // the second 01:30
  })

  it('"today" for a NY block at 2026-07-01T03:30Z is 30 Jun', () => {
    const nowMs = at('2026-07-01T03:30:00Z')
    expect(todayStrIn(NY, nowMs)).toBe('2026-06-30')
    // Shift over: a NY block dated 30 Jun that ended at 22:00 EDT is over; Dublin would call 30 Jun "yesterday" too,
    // but a NY block dated 1 Jul is still in the future in New York.
    expect(coachShiftOver({ blockDate: '2026-07-01', from: { end_time: '08:00:00' }, to: { end_time: '08:00:00' }, nowMs, timeZone: NY })).toBe(false)
    expect(coachShiftOver({ blockDate: '2026-06-30', from: { end_time: '22:00:00' }, to: { end_time: '22:00:00' }, nowMs, timeZone: NY })).toBe(true)
    expect(coachShiftOver({ blockDate: '2026-06-30', from: { end_time: '23:59:00' }, to: { end_time: '23:59:00' }, nowMs, timeZone: NY })).toBe(false)
    // The notice: quiet at 23:30 EDT, so the next morning is 1 Jul in New York; a 07:10 shift on 1 Jul is too late.
    const windows = [{ from: { start_time: '07:10:00' }, to: { start_time: '07:10:00' } }]
    expect(blockEditNoticeWhen({ nowMs, timeZone: NY, blockDate: '2026-07-01', windows })).toBe('too_late')
    expect(blockEditNoticeWhen({ nowMs, timeZone: NY, blockDate: '2026-07-02', windows })).toBe('morning')
  })

  it('a NY studio\'s 06:00 shift on Sun 1 Nov 2026 (fall-back) is reminded at 20:00 EDT the evening before', () => {
    const s = { id: 'a', profile_id: 'p', location_id: 'N', shift_date: '2026-11-01', block_start_time: '06:00:00', block_end_time: '09:00:00' }
    const plan = reminderPlanFor(s, NY)
    expect(plan.kind).toBe('evening_before')
    expect(plan.fireAtMs).toBe(at('2026-11-01T00:00:00Z')) // 20:00 EDT on 31 Oct
    expect(plan.startMs).toBe(at('2026-11-01T11:00:00Z')) // 06:00 EST
    expect(plan.leadMinutes).toBe(660) // the repeated hour makes it 11 real hours
    // At 20:30 EDT on 31 Oct (00:30Z on 1 Nov) the wording is "tomorrow" in New York, "today" on a Dublin clock.
    const nowMs = at('2026-11-01T00:30:00Z')
    expect(buildShiftReminderMessage({ run: [s], nowMs, zone: NY }).title).toBe('Shift tomorrow at 06:00')
    expect(buildShiftReminderMessage({ run: [s], nowMs, zone: DUB }).title).toBe('Shift today at 06:00')
  })

  it('the reminder arm reads each studio\'s today..tomorrow: one read spans New York\'s and Dublin\'s days', async () => {
    // 01:30Z on 2 Jul 2026: 02:30 IST on 2 Jul in Dublin (quiet), 21:30 EDT on 1 Jul in New York (in band).
    const db = recDb({ shift_assignments: [] })
    await runShiftReminders(db, { nowMs: at('2026-07-02T01:30:00Z'), locations: [{ id: 'D', timezone: DUB }, { id: 'N', timezone: NY }] })
    const read = db.queries.find((q) => q.gte.length)
    expect(read).toBeDefined()
    // New York is in band (21:30), Dublin is not; the read covers NY's 1 Jul to Dublin's 3 Jul.
    expect(JSON.stringify(read.gte)).toContain('2026-07-01')
    expect(JSON.stringify(read.lte)).toContain('2026-07-03')
  })

  it('block-edit notices hold each row to its OWN studio\'s day', () => {
    const row = (id, loc, date) => ({
      id, location_id: loc, block_id: `b-${id}`, block_date: date, coach_id: `c-${id}`, created_at: '2026-06-30T20:00:00Z',
      details: { from: { start_time: '10:00:00', end_time: '11:00:00' } },
      shift_blocks: { start_time: '12:00:00', end_time: '13:00:00', shift_assignments: [{ profile_id: `c-${id}`, status: 'scheduled' }] },
    })
    // 03:30Z on 1 Jul: Dublin's day is 1 Jul, New York's is 30 Jun.
    const plan = planTimeChangeNotices([row('ny', 'N', '2026-06-30'), row('d', 'D', '2026-06-30')], {
      todayByLocation: { N: '2026-06-30', D: '2026-07-01' }, nowHHMMByLocation: { N: '23:30', D: '04:30' },
    })
    expect(plan.send.map((n) => n.locationId)).toEqual([])
    expect(plan.silent.map((r) => r.id).sort()).toEqual(['d', 'ny']) // NY: its 12:00 shift is over by 23:30; Dublin: yesterday
    const later = planTimeChangeNotices([row('ny', 'N', '2026-06-30')], { todayByLocation: { N: '2026-06-30' }, nowHHMMByLocation: { N: '08:00' } })
    expect(later.send.map((n) => n.locationId)).toEqual(['N'])
  })

  it('the change-log drawer reads a NY studio\'s stamp on New York\'s clock', () => {
    const c = { action: 'assigned', details: {}, block_date: '2026-06-30', created_at: '2026-07-01T01:00:00Z', notified_at: '2026-07-01T03:30:00Z', actor_name: 'Mgr' }
    expect(rosterChangeTold(c, NY)).toBe('told 23:30') // 30 Jun in New York: not "past", and the same day as the change
    expect(rosterChangeByline(c, NY)).toBe('Mgr · 30 Jun 21:00')
    expect(rosterChangeTold(c, DUB)).toBe(null) // on a Dublin clock the 30 Jun shift was already past at the stamp
  })

  it('"Published vs now" labels a NY publish in New York', () => {
    expect(publishedLabel('2026-11-01T05:30:00Z', NY)).toBe('Sun 1 Nov, 01:30') // first 01:30 (EDT)
    expect(publishedLabel('2026-11-01T06:30:00Z', NY)).toBe('Sun 1 Nov, 01:30') // second 01:30 (EST)
    expect(publishedLabel('2026-03-08T07:00:00Z', NY)).toBe('Sun 8 Mar, 03:00')
  })

  it('the Today chip: a NY studio\'s week runs on New York\'s day', async () => {
    const db = recDb({ shift_blocks: [] })
    // Sun 1 Nov 03:30Z is still Sat 31 Oct in New York, so its week ends Sun 1 Nov.
    await fetchStaffingGapsThisWeek(db, ['N'], { zones: new Map([['N', NY]]), nowMs: at('2026-11-01T03:30:00Z') })
    expect(db.queries[0].gte).toEqual([['block_date', '2026-10-31']])
    expect(db.queries[0].lte).toEqual([['block_date', '2026-11-01']])
  })

  it('the runway: a NY studio\'s "next week" turns at New York\'s Monday, not Dublin\'s', async () => {
    const tables = { shift_templates: [{ id: 't', location_id: 'N', days_of_week: ['mon'], kind: 'class' }], shift_blocks: [] }
    const db = recDb(tables)
    // Mon 9 Mar 02:00Z is still Sun 8 Mar in New York: its next week starts Mon 9 Mar.
    await fetchRosterRunways(db, ['N'], { zones: { N: NY }, nowMs: at('2026-03-09T02:00:00Z') })
    expect(db.queries[1].gte).toEqual([['block_date', '2026-03-09']])
    const dub = recDb(tables)
    await fetchRosterRunways(dub, ['N'], { zones: { N: DUB }, nowMs: at('2026-03-09T02:00:00Z') })
    expect(dub.queries[1].gte).toEqual([['block_date', '2026-03-16']])
  })

  it('an unreadable zone fails the runway and staffing reads, never a guessed day', async () => {
    const down = recDb({ locations: { data: null, error: { message: 'down' } }, shift_templates: [{ id: 't', location_id: 'N', days_of_week: ['mon'], kind: 'class' }] })
    // recDb answers a function or rows; make `locations` an error answer.
    down.from = ((orig) => (table) => (table === 'locations'
      ? { select: () => ({ in: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }) }
      : orig(table)))(down.from.bind(down))
    expect(await fetchRosterRunways(down, ['N'])).toMatchObject({ success: false })
    expect(await fetchStaffingGapsThisWeek(down, ['N'])).toMatchObject({ success: false })
  })

  it('a trimmed remnant is judged on the studio\'s day, and skipped (never guessed) without one', async () => {
    const db = recDb()
    const trimmed = [{ id: 'old', trim_to: { period_start: '2026-06-22', period_end: '2026-06-30' } }]
    // 03:30Z on 1 Jul: 30 Jun in New York, so the remnant still reaches "today" and is kept.
    const ny = await supersedeEmptyTrimmedRosters(db, { newRosterId: 'new', trimmed, timeZone: NY, nowMs: at('2026-07-01T03:30:00Z') })
    expect(ny.future).toEqual(['old'])
    const none = await supersedeEmptyTrimmedRosters(db, { newRosterId: 'new', trimmed })
    expect(none.warning).toMatch(/skipped/)
    expect(none.superseded).toEqual([])
  })
})
