// tz-8a.tz.test.js — TZ.8a: rostering, shifts, swaps, availability and staff
// push decisions take EACH STUDIO's zone (locations.timezone).
//
// Two halves, as every sweep: (1) Europe/Dublin is byte-identical to the
// frozen pre-change code (tz-8a*.legacy-dublin.test-helpers.js) over the
// DST-edge samples and every day / hour / quarter-hour of 2026; (2)
// America/New_York follows New York's clock across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const LEGACY = await import('./tz-8a.legacy-dublin.test-helpers.js')
const LEGACY_WT = await import('./tz-8a.working-time.legacy-dublin.test-helpers.js')
const LEGACY_CAND = await import('./tz-8a.candidates.legacy-dublin.test-helpers.js')
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
const { dublinDayStr } = await import('./dublin-time.js')

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
const pad = (n) => String(n).padStart(2, '0')
const QUARTERS = (() => {
  const out = []
  for (let m = 0; m < 1440; m += 15) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`)
  return out
})()
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

describe('TZ.8a Europe/Dublin is byte-identical', () => {
  it('workingWindow: every quarter-hour start of every 2026 day (no zone, and zone Europe/Dublin)', () => {
    const bad = []
    for (const d of DAYS_2026) {
      for (const t of QUARTERS) {
        const row = shift({ block_date: d, start_time: t, end_time: '23:59:59' })
        const legacy = LEGACY_WT.workingWindowLegacyDublin(row)
        if (JSON.stringify(WT.workingWindow(row)) !== JSON.stringify(legacy)) bad.push(`${d} ${t}`)
        if (JSON.stringify(WT.workingWindow({ ...row, timezone: DUB })) !== JSON.stringify(legacy)) bad.push(`${d} ${t} tz`)
      }
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('workingWindow: 24:00 ends, seconds, a rolled-over date and both DST nights', () => {
    const rows = [
      shift({ block_date: '2026-03-28', start_time: '22:00:00', end_time: '24:00:00' }),
      shift({ block_date: '2026-10-24', start_time: '20:00:30', end_time: '24:00:00' }),
      shift({ block_date: '2026-03-29', start_time: '01:30:00', end_time: '02:30:00' }), // the skipped hour
      shift({ block_date: '2026-10-25', start_time: '01:30:00', end_time: '01:45:00' }), // the repeated hour
      shift({ block_date: '2026-02-30', start_time: '09:00:00', end_time: '10:00:00' }), // rolls over, as before
      shift({ block_date: '2026-06-01', start_time: '9:05', end_time: '23:00' }),
      shift({ block_date: '2026-06-01', start_time: '22:00:00', end_time: '06:00:00' }), // overnight (defence)
    ]
    for (const row of rows) expect(WT.workingWindow(row)).toStrictEqual(LEGACY_WT.workingWindowLegacyDublin(row))
  })

  // A week of a coach's shifts around each Dublin DST change.
  const weekAround = (monday) => Array.from({ length: 7 }, (_, i) => [
    shift({ block_id: `${monday}-${i}-a`, block_date: addDays(monday, i), start_time: '06:00:00', end_time: '13:30:00' }),
    shift({ block_id: `${monday}-${i}-b`, block_date: addDays(monday, i), start_time: '17:00:00', end_time: '22:30:00' }),
  ]).flat()
  it.each(['2026-03-23', '2026-10-19', '2026-06-29'])('rest gaps, long weeks and the publish advisories: week of %s', (monday) => {
    const shifts = weekAround(monday)
    const people = new Map([['p1', { full_name: 'Coach A', employment_type: 'fte' }]])
    expect(WT.restGapViolations(shifts)).toStrictEqual(LEGACY_WT.restGapViolationsLegacyDublin(shifts))
    expect(WT.restGapViolations(shifts, { restScope: 'shift' })).toStrictEqual(LEGACY_WT.restGapViolationsLegacyDublin(shifts, { restScope: 'shift' }))
    expect(WT.weekHoursOver(shifts)).toStrictEqual(LEGACY_WT.weekHoursOverLegacyDublin(shifts))
    const opts = { people, hereLocationId: 'L', from: monday, to: addDays(monday, 6), todayIso: monday }
    expect(WT.workingTimeAdvisories(shifts, opts)).toStrictEqual(LEGACY_WT.workingTimeAdvisoriesLegacyDublin(shifts, opts))
    const cand = shift({ profile_id: 'p1', block_id: 'new', block_date: addDays(monday, 6), start_time: '05:00:00', end_time: '09:00:00' })
    expect(WT.candidateWorkingTime(shifts, cand)).toStrictEqual(LEGACY_WT.candidateWorkingTimeLegacyDublin(shifts, cand))
  })

  it.each(['2026-03-29', '2026-10-25', '2026-07-15'])('buildCandidates: a block on %s', (date) => {
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
    expect(buildCandidates(args)).toStrictEqual(LEGACY_CAND.buildCandidatesLegacyDublin(args))
    // The studio zone on the block (Dublin) changes nothing either.
    expect(buildCandidates({ ...args, block: { ...block, locations: { timezone: DUB } } })).toStrictEqual(LEGACY_CAND.buildCandidatesLegacyDublin(args))
  })

  it('staff quiet hours: the wall clock, the band and the resolver, every quarter-hour of 2026', () => {
    const bad = []
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 15 * 60_000) {
      for (const tz of [DUB, null, undefined, 'Mars/Olympus', '']) {
        if (staffWallClockHHMM(t, tz) !== LEGACY.staffWallClockHHMMLegacy(t, tz)) bad.push([t, tz, 'hhmm'])
        if (inStaffPushHours(t, tz) !== LEGACY.inStaffPushHoursLegacy(t, tz)) bad.push([t, tz, 'band'])
      }
    }
    expect(bad).toEqual([])
    for (const tz of [DUB, null, undefined, 'Mars/Olympus', '', '   ', 42, NY]) {
      expect(resolveStaffTimeZone(tz)).toStrictEqual(LEGACY.resolveStaffTimeZoneLegacy(tz))
    }
  }, 60_000)

  it('block edits: the notice day and "shift over", every hour of 2026', () => {
    const bad = []
    const windows = [{ from: { start_time: '07:10:00', end_time: '08:00:00' }, to: { start_time: '07:20:00', end_time: '08:30:00' } }]
    for (const nowMs of HOURS_2026) {
      const today = dublinDayStr(nowMs)
      for (const blockDate of [addDays(today, -1), today, addDays(today, 1)]) {
        for (const timeZone of [DUB, null]) {
          const a = { nowMs, timeZone, blockDate, windows }
          if (blockEditNoticeWhen(a) !== LEGACY.blockEditNoticeWhenLegacyDublin(a)) bad.push([nowMs, blockDate, 'when'])
          const o = { blockDate, from: windows[0].from, to: windows[0].to, nowMs, timeZone }
          if (coachShiftOver(o) !== LEGACY.coachShiftOverLegacyDublin(o)) bad.push([nowMs, blockDate, 'over'])
        }
      }
    }
    expect(bad).toEqual([])
  }, 60_000)

  it('the change-log drawer: told time, told day and byline, every hour of 2026', () => {
    const bad = []
    for (const ms of HOURS_2026) {
      const notified = new Date(ms + 5 * 60_000).toISOString()
      const c = { action: 'assigned', details: {}, block_date: dublinDayStr(ms), created_at: new Date(ms - 3 * 3_600_000).toISOString(), notified_at: notified, actor_name: 'Mgr' }
      for (const zone of [DUB, null, undefined]) {
        if (stampMeansTold(c, zone) !== LEGACY.stampMeansToldLegacyDublin(c)) bad.push([ms, 'means'])
        if (rosterChangeTold(c, zone) !== LEGACY.rosterChangeToldLegacyDublin(c)) bad.push([ms, 'told'])
        if (rosterChangeByline(c, zone) !== LEGACY.rosterChangeBylineLegacyDublin(c)) bad.push([ms, 'byline'])
      }
    }
    expect(bad).toEqual([])
  }, 60_000)

  it('"Published vs now": the publish label and the before-snapshots message, every hour of 2026', () => {
    const bad = []
    for (const ms of HOURS_2026) {
      const iso = new Date(ms).toISOString()
      if (publishedLabel(iso) !== LEGACY.publishedLabelLegacyDublin(iso)) bad.push(iso)
      if (publishedLabel(iso, DUB) !== LEGACY.publishedLabelLegacyDublin(iso)) bad.push(`${iso} tz`)
      const d = { missing_reason: 'before_snapshots', snapshots_began_at: iso }
      if (missingSnapshotMessage({ ...d, timezone: DUB }) !== LEGACY.missingSnapshotMessageLegacyDublin(d)) bad.push(`${iso} msg`)
    }
    expect(bad).toEqual([])
  }, 60_000)

  it.each(SAMPLES)('the shift reminder\'s today/tomorrow wording at %s', (iso) => {
    const nowMs = at(iso)
    const today = dublinDayStr(nowMs)
    for (const date of [today, addDays(today, 1), addDays(today, 2)]) {
      const run = [{ id: 'a', profile_id: 'p', location_id: 'L', shift_date: date, block_start_time: '06:00:00', block_end_time: '08:00:00', shift_templates: { name: 'Early' } }]
      const args = { run, nameByLocation: { L: 'North' }, coNames: ['Bo'], nowMs }
      expect(buildShiftReminderMessage({ ...args, zone: DUB })).toStrictEqual(LEGACY.buildShiftReminderMessageLegacyDublin(args))
      expect(buildShiftReminderMessage(args)).toStrictEqual(LEGACY.buildShiftReminderMessageLegacyDublin(args))
    }
  })

  it.each(SAMPLES)('the Today chip reads and counts on the Dublin day at %s', async (iso) => {
    const nowMs = at(iso)
    const blocks = (q) => ({ data: [
      { id: 'b1', location_id: 'L', block_date: dublinDayStr(nowMs), start_time: '23:00:00', min_coaches: 1, shift_templates: { kind: 'class' }, shift_assignments: [] },
      { id: 'b2', location_id: 'L', block_date: addDays(dublinDayStr(nowMs), 1), start_time: '09:00:00', min_coaches: 1, shift_templates: { kind: 'class' }, shift_assignments: [] },
    ].filter((b) => b.block_date >= q.gte[0][1] && b.block_date <= q.lte[0][1]), error: null })
    const zoned = recDb({ shift_blocks: blocks })
    const pinned = recDb({ shift_blocks: blocks })
    const a = await fetchStaffingGapsThisWeek(zoned, ['L'], { zones: new Map([['L', DUB]]), nowMs })
    const b = await fetchStaffingGapsThisWeek(pinned, ['L'], { todayIso: dublinDayStr(nowMs) })
    expect(a).toStrictEqual(b)
    expect(zoned.queries[0].gte).toStrictEqual(pinned.queries[0].gte)
    expect(zoned.queries[0].lte).toStrictEqual(pinned.queries[0].lte)
  })

  it.each(SAMPLES)('the roster runway reads and judges on the Dublin day at %s', async (iso) => {
    const nowMs = at(iso)
    const tables = {
      shift_templates: [{ id: 't', location_id: 'L', days_of_week: ['mon'], kind: 'class' }],
      shift_blocks: (q) => ({ data: [7, 8, 9, 10, 14, 15].map((n) => ({
        id: `b${n}`, location_id: 'L', block_date: addDays(dublinDayStr(nowMs), n), min_coaches: 1,
        shift_templates: { kind: 'class' }, rosters: { status: 'draft' }, shift_assignments: [],
      })).filter((b) => b.block_date >= q.gte[0][1] && b.block_date <= q.lte[0][1]), error: null }),
    }
    const zoned = recDb(tables)
    const pinned = recDb(tables)
    const a = await fetchRosterRunways(zoned, ['L'], { zones: { L: DUB }, nowMs })
    const b = await fetchRosterRunways(pinned, ['L'], { todayIso: dublinDayStr(nowMs) })
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
