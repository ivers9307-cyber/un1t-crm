// CANDIDATES.1 — ranked candidates. Pure: no clock, no database. Run under
// TZ=Europe/Dublin AND a US zone; nothing here may move with the host.

import { describe, it, expect } from 'vitest'
import {
  CANDIDATE_TIERS, CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
  candidateTier, compareCandidates, rankCandidates, candidateTone,
  candidateBadges, candidateHoursLine, candidateMeta, candidateReason,
  candidatesUncheckedNote, parseCandidatesAnswer,
  candidateFacts, buildCandidates,
} from './candidates.js'

describe('candidateTier', () => {
  it('ready, advisory, unavailable, blocked — in that order of badness', () => {
    expect(CANDIDATE_TIERS).toEqual(['ready', 'advisory', 'unavailable', 'blocked'])
    expect(candidateTier({})).toBe('ready')
    expect(candidateTier({ free: null })).toBe('ready') // unknown is neutral
    expect(candidateTier({ rest_gap: { rest_minutes: 600 } })).toBe('advisory')
    expect(candidateTier({ week_over: { minutes: 2940 } })).toBe('advisory')
    expect(candidateTier({ unavailable: { summary: 'all day' }, rest_gap: { rest_minutes: 1 } })).toBe('unavailable')
    expect(candidateTier({ free: false, unavailable: { summary: 'all day' } })).toBe('blocked')
    expect(candidateTier({ on_leave: { type: 'holiday' } })).toBe('blocked')
  })
})

describe('rankCandidates', () => {
  it('tier, then on site, then under-contract share, then fewest hours, then name', () => {
    const list = [
      { profile_id: 'z', full_name: 'Zoe', free: false },
      { profile_id: 'y', full_name: 'Yan', unavailable: { summary: 'all day' } },
      { profile_id: 'x', full_name: 'Xia', rest_gap: { rest_minutes: 600 } },
      { profile_id: 'c', full_name: 'Cal', free: true, week_minutes: 0 },
      { profile_id: 'b', full_name: 'Bea', free: true, week_minutes: 1200, contracted_hours: 39 },
      { profile_id: 'a', full_name: 'Abe', free: true, week_minutes: 600, contracted_hours: 20 },
      { profile_id: 'o', full_name: 'Ola', free: true, week_minutes: 2400, contracted_hours: 20 },
      { profile_id: 's', full_name: 'Sam', free: true, week_minutes: 900, on_site: { start: '07:00', end: '09:00' } },
      { profile_id: 'd', full_name: 'Dee', free: true, week_minutes: 0 },
    ]
    const ranked = rankCandidates(list)
    // s on site; a (10h of 20h = 0.50) before b (20h of 39h = 0.51); then the
    // no-contract / over-contract group by hours: c 0h, d 0h (name), o 40h.
    expect(ranked.map((c) => c.profile_id)).toEqual(['s', 'a', 'b', 'c', 'd', 'o', 'x', 'y', 'z'])
    expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ranked.map((c) => c.tier)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'advisory', 'unavailable', 'blocked'])
    expect(list[0]).not.toHaveProperty('rank') // a copy, never mutates
  })

  it('an unknown week is neutral: those rows fall back to name, then id', () => {
    const ranked = rankCandidates([
      { profile_id: '2', full_name: 'ann', week_minutes: null },
      { profile_id: '1', full_name: 'Ann', week_minutes: null },
      { profile_id: '3', full_name: 'Aaron' },
    ])
    expect(ranked.map((c) => c.profile_id)).toEqual(['3', '1', '2'])
    expect(compareCandidates(ranked[1], ranked[2])).toBeLessThan(0)
  })

  it('tone follows the tier', () => {
    expect(['ready', 'advisory', 'unavailable', 'blocked'].map((tier) => candidateTone({ tier }))).toEqual(['good', 'warn', 'muted', 'bad'])
    expect(candidateTone(null)).toBe('muted')
  })
})

describe('words', () => {
  const FACTS = {
    profile_id: 'p', full_name: 'P', role: 'staff', free: false,
    busy: { block_id: 'b', date: '2026-05-06', start: '09:30', end: '10:30', name: 'Morning HIIT', location_name: 'Studio South' },
    on_leave: { label: 'Sick leave', start_date: '2026-05-06', end_date: '2026-05-06' },
    unavailable: { summary: 'all day', detail: '6 May, all day' },
    rest_gap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } },
    week_over: { week_start: '2026-05-04', minutes: 2910 },
    on_site: null, week_minutes: 2790, contracted_hours: 37.5,
  }

  it('badges keep the picker\'s existing words and titles', () => {
    expect(candidateBadges(FACTS)).toEqual([
      { key: 'leave', tone: 'bad', text: 'on approved leave', title: 'Sick leave, Wed 6 May' },
      { key: 'busy', tone: 'warn', text: 'clashes with 9:30am Morning HIIT', title: 'Already on Morning HIIT, 9:30am–10:30am at Studio South' },
      { key: 'unavailable', tone: 'muted', text: 'Unavailable: all day', title: '6 May, all day' },
      { key: 'rest', tone: 'warn', text: '9h 30m rest', title: 'Only 9h 30m between this shift and Evening 8pm–9:30pm at Studio South on Tue 5 May. Employees need 11 hours between working days.' },
      { key: 'week', tone: 'warn', text: '48h 30m this week', title: 'Assigning this shift brings their week to 48h 30m across every studio, over the 48-hour limit.' },
    ])
    expect(candidateBadges({ free: true })).toEqual([])
    expect(candidateBadges({ on_leave: { label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } })[0].title)
      .toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('the hours line: share of a contract, plain hours, or none', () => {
    expect(candidateHoursLine(FACTS)).toBe('46h 30m of 37.5h this week')
    expect(candidateHoursLine({ week_minutes: 0, contracted_hours: 30 })).toBe('0h of 30h this week')
    expect(candidateHoursLine({ week_minutes: 120 })).toBe('2h this week')
    expect(candidateHoursLine({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateHoursLine({ week_minutes: null, contracted_hours: 39 })).toBeNull()
  })

  it('meta line: on site, then hours', () => {
    expect(candidateMeta({ on_site: { start: '07:00', end: '09:00' }, week_minutes: 120 })).toBe('Here 7am–9am · 2h this week')
    expect(candidateMeta({ week_minutes: 0 })).toBe('No shifts this week')
    expect(candidateMeta({})).toBeNull()
  })

  it('reason: the worst thing first, then the hours; a colleague sees free or working only', () => {
    expect(candidateReason(FACTS)).toBe('On leave (Sick leave) · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null })).toBe('Working 9:30am–10:30am Morning HIIT at Studio South · 46h 30m of 37.5h this week')
    expect(candidateReason({ ...FACTS, on_leave: null, busy: null, free: true })).toBe('Unavailable all day · 46h 30m of 37.5h this week')
    expect(candidateReason({ rest_gap: FACTS.rest_gap, week_minutes: 90, contracted_hours: 39 })).toBe('Only 9h 30m rest · 1h 30m of 39h this week')
    expect(candidateReason({ week_over: { minutes: 2940 }, week_minutes: 2820, contracted_hours: 39 })).toBe('49h with this shift · 47h of 39h this week')
    expect(candidateReason({ free: true, on_site: { start: '12:00', end: '13:00' }, week_minutes: 60 })).toBe('Here 12pm–1pm · 1h this week')
    expect(candidateReason({ free: true, week_minutes: 240, contracted_hours: 39 })).toBe('Free · 4h of 39h this week')
    expect(candidateReason({})).toBeNull()
    expect(candidateReason({ free: true }, 'colleague')).toBe('Free then')
    expect(candidateReason({ free: false }, 'colleague')).toBe('Working then')
    expect(candidateReason({ free: null }, 'colleague')).toBeNull()
  })

  it('what could not be checked, in words', () => {
    expect(candidatesUncheckedNote({ shifts: true, leave: false })).toBe('Could not check leave, so the order may be off.')
    expect(candidatesUncheckedNote({ leave: false, availability: false })).toBe('Could not check leave and availability, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: false, cross_studio: false, contract: false }))
      .toBe('Could not check other shifts, the other studios and contracted hours, so the order may be off.')
    expect(candidatesUncheckedNote({ shifts: true })).toBeNull()
    expect(candidatesUncheckedNote(undefined)).toBeNull()
    expect(CANDIDATES_RANKING_NOTE).toBe('Ranking coaches…')
    expect(CANDIDATES_UNRANKED_NOTE).toBe('Coaches could not be checked or ranked, so they are listed A–Z.')
  })
})

describe('parseCandidatesAnswer', () => {
  it('a failed or missing answer is failed; a success of another shape is unrecognised', () => {
    expect(parseCandidatesAnswer(null)).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: false, error: 'boom' })).toEqual({ ok: false, reason: 'failed' })
    expect(parseCandidatesAnswer({ success: true, data: [] })).toEqual({ ok: false, reason: 'unrecognised' })
    expect(parseCandidatesAnswer({ success: true, data: { byProfile: {} } })).toEqual({ ok: false, reason: 'unrecognised' })
  })

  it('orders by rank, drops junk rows, defaults the rest', () => {
    const out = parseCandidatesAnswer({ success: true, data: { candidates: [
      { profile_id: 'b', rank: 2 }, null, { rank: 3 }, { profile_id: 'a', rank: 1 }, { profile_id: 'c' },
    ] } })
    expect(out).toEqual({
      ok: true, audience: 'manager', checked: {}, untimed: 0,
      candidates: [{ profile_id: 'a', rank: 1 }, { profile_id: 'b', rank: 2 }, { profile_id: 'c' }],
    })
    expect(parseCandidatesAnswer({ success: true, data: { audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 } }))
      .toEqual({ ok: true, audience: 'colleague', candidates: [], checked: { shifts: false }, untimed: 2 })
  })
})

// One Wednesday shift, 10:00–12:00 at Studio North, and eight people around it.
const HERE = 'loc-here'
const THERE = 'loc-there'
const BLOCK = {
  id: 'blk', location_id: HERE, block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00', kind: 'class' },
}
// A live assignment in the flat shape src/lib/working-time-data.js returns.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  profile_id, block_id: `${profile_id}-${block_date}-${start_time}`, block_date, start_time, end_time,
  location_id: HERE, location_name: 'Studio North', name: 'Class', status: 'scheduled',
  start_time_override: null, end_time_override: null, shift_templates: { start_time, end_time }, ...over,
})
const M = (profile_id, full_name, employment_type = 'fte') => ({ profile_id, full_name, role: 'staff', employment_type })
const MEMBERS = [
  M('ann', 'Ann Free'), M('bob', 'Bob Here', 'contractor'), M('cat', 'Cat Busy'), M('dan', 'Dan Away', 'contractor'),
  M('eve', 'Eve Unavail'), M('fay', 'Fay Late'), M('gus', 'Gus Steady'), M('hal', 'Hal Contract', 'contractor'),
]
const SHIFTS = [
  S('ann', '2026-09-21', '09:00:00', '13:00:00'),
  S('bob', '2026-09-23', '07:00:00', '09:00:00', { name: 'Early' }),
  S('cat', '2026-09-23', '11:00:00', '13:00:00', { location_id: THERE, location_name: 'Studio South', name: 'Lunch Pilates' }),
  S('fay', '2026-09-22', '21:00:00', '23:30:00', { location_id: THERE, location_name: 'Studio South', name: 'Late' }),
  S('gus', '2026-09-21', '09:00:00', '17:00:00'),
  S('gus', '2026-09-22', '09:00:00', '17:00:00'),
  S('hal', '2026-09-28', '09:00:00', '10:00:00'), // next Monday: read, but not this week
]
const LEAVE = [{ profile_id: 'dan', type: 'holiday', start_date: '2026-09-22', end_date: '2026-09-24' }]
const RULES = [{ profile_id: 'eve', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '09:00', end_time: '11:00', note: 'School run' }]
// bob is a contractor with a stray row: contractors never show one.
const CONTRACTS = new Map([['ann', 39], ['cat', 20], ['eve', 30], ['fay', 39], ['gus', 39], ['bob', 25]])
const ALL_CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true, contract: true }
const build = (over = {}) => buildCandidates({
  block: BLOCK, members: MEMBERS, shifts: SHIFTS, leave: LEAVE, rules: RULES, contracts: CONTRACTS, checked: ALL_CHECKED, ...over,
})

describe('buildCandidates — manager', () => {
  it('ranks: on site, under contract, the rest, short rest, unavailable, then working or on leave', () => {
    const { candidates } = build()
    expect(candidates.map((c) => c.profile_id)).toEqual(['bob', 'ann', 'gus', 'hal', 'fay', 'eve', 'cat', 'dan'])
    expect(Object.fromEntries(candidates.map((c) => [c.profile_id, c.reason]))).toEqual({
      bob: 'Here 7am–9am · 2h this week',
      ann: 'Free · 4h of 39h this week',
      gus: 'Free · 16h of 39h this week',
      hal: 'Free · No shifts this week',
      fay: 'Only 10h 30m rest · 2h 30m of 39h this week',
      eve: 'Unavailable 9am–11am · 0h of 30h this week',
      cat: 'Working 11am–1pm Lunch Pilates at Studio South · 2h of 20h this week',
      dan: 'On leave (Holiday) · No shifts this week',
    })
  })

  it('carries each fact, the other studio named, this one not', () => {
    const by = Object.fromEntries(build().candidates.map((c) => [c.profile_id, c]))
    expect(by.bob).toMatchObject({ free: true, busy: null, on_site: { start: '07:00', end: '09:00', name: 'Early', gap_minutes: 60 }, week_minutes: 120, contracted_hours: null, rest_gap: null })
    expect(by.cat).toMatchObject({ free: false, busy: { date: '2026-09-23', start: '11:00', end: '13:00', name: 'Lunch Pilates', location_name: 'Studio South' }, tier: 'blocked' })
    // CANDIDATES.1 review 5 — the label, never the raw type value.
    expect(by.dan.on_leave).toEqual({ label: 'Holiday', start_date: '2026-09-22', end_date: '2026-09-24' })
    expect(by.eve.unavailable).toEqual({ summary: '9am–11am', detail: 'Wednesdays, 9am–11am (School run)' })
    expect(by.fay.rest_gap).toMatchObject({ rest_minutes: 630, side: 'before', other: { date: '2026-09-22', start: '21:00', end: '23:30', name: 'Late', location_name: 'Studio South' } })
    expect(by.hal.week_minutes).toBe(0)
    expect(by.ann).toMatchObject({ contracted_hours: 39, week_minutes: 240, on_site: null, rank: 2, tier: 'ready' })
  })

  it('an override counts (effective window); an end that only touches is on site, not busy', () => {
    const { candidates } = buildCandidates({
      block: BLOCK, checked: ALL_CHECKED,
      members: [M('jay', 'Jay Late', 'contractor'), M('kim', 'Kim Next', 'contractor')],
      shifts: [
        S('jay', '2026-09-23', '07:00:00', '09:00:00', { end_time_override: '10:30:00' }),
        S('kim', '2026-09-23', '12:00:00', '13:00:00'),
      ],
    })
    const [kim, jay] = candidates
    expect(kim).toMatchObject({ profile_id: 'kim', free: true, on_site: { start: '12:00', end: '13:00', gap_minutes: 0 }, reason: 'Here 12pm–1pm · 1h this week' })
    expect(jay).toMatchObject({ profile_id: 'jay', free: false, busy: { start: '07:00', end: '10:30', location_name: null }, tier: 'blocked' })
  })

  it('48 hours: an employee this shift takes over the week is advisory; a contractor never is', () => {
    const ivy = [
      S('ivy', '2026-09-21', '06:00:00', '18:00:00'), S('ivy', '2026-09-22', '06:00:00', '18:00:00'),
      S('ivy', '2026-09-24', '06:00:00', '18:00:00'), S('ivy', '2026-09-25', '06:00:00', '17:00:00'),
    ]
    const lee = ivy.map((s) => ({ ...s, profile_id: 'lee', block_id: `lee-${s.block_date}` }))
    const { candidates } = buildCandidates({
      block: BLOCK, checked: ALL_CHECKED, contracts: new Map([['ivy', 39]]),
      members: [M('ivy', 'Ivy Long'), M('lee', 'Lee Long', 'contractor')], shifts: [...ivy, ...lee],
    })
    const by = Object.fromEntries(candidates.map((c) => [c.profile_id, c]))
    expect(by.ivy).toMatchObject({ week_minutes: 2820, week_over: { week_start: '2026-09-21', minutes: 2940 }, tier: 'advisory', reason: '49h with this shift · 47h of 39h this week' })
    expect(by.lee).toMatchObject({ week_minutes: 2820, week_over: null, rest_gap: null, tier: 'ready' })
  })

  it('what was not read is null, never false: everyone ready, ranked by name, no reason', () => {
    const { candidates } = build({ checked: { shifts: false, cross_studio: true, leave: false, availability: false, contract: false } })
    expect(candidates.map((c) => c.profile_id)).toEqual(['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal'])
    for (const c of candidates) {
      expect(c).toMatchObject({ free: null, busy: null, on_site: null, week_minutes: null, on_leave: null, unavailable: null, contracted_hours: null, tier: 'ready', reason: null })
    }
  })

  it('counts shifts without usable times, and never returns a pay field', () => {
    const { candidates, untimed } = build({ shifts: [...SHIFTS, S('ann', '2026-09-24', null, null, { shift_templates: { start_time: null, end_time: null } })] })
    expect(untimed).toBe(1)
    expect(JSON.stringify(candidates)).not.toMatch(/rate|salary|overtime|cost/)
  })
})

// CANDIDATES.1 review 2 — when the other studios could not be read, "free"
// only means free HERE, and every surface says so.
describe('the other studios unchecked: "Free here", never a bare "Free"', () => {
  const NOT_ELSEWHERE = { crossStudioChecked: false }

  it('reason, manager and colleague', () => {
    expect(candidateReason({ free: true, week_minutes: 240, contracted_hours: 39 }, 'manager', NOT_ELSEWHERE)).toBe('Free here · 4h of 39h this week')
    expect(candidateReason({ free: true }, 'colleague', NOT_ELSEWHERE)).toBe('Free here then')
    expect(candidateReason({ free: false }, 'colleague', NOT_ELSEWHERE)).toBe('Working then')
    // Checked (the default): unchanged.
    expect(candidateReason({ free: true, week_minutes: 240, contracted_hours: 39 })).toBe('Free · 4h of 39h this week')
    expect(candidateReason({ free: true }, 'colleague')).toBe('Free then')
  })

  it("the web row's meta line says it too, only when nothing worse leads", () => {
    expect(candidateMeta({ free: true, week_minutes: 120 }, NOT_ELSEWHERE)).toBe('Free here · 2h this week')
    expect(candidateMeta({ free: true, week_minutes: 120 })).toBe('2h this week')
    expect(candidateMeta({ free: true, on_site: { start: '07:00', end: '09:00' }, week_minutes: 120 }, NOT_ELSEWHERE)).toBe('Here 7am–9am · 2h this week')
    expect(candidateMeta({ free: true, on_leave: { label: 'Holiday' }, week_minutes: 0 }, NOT_ELSEWHERE)).toBe('No shifts this week')
    expect(candidateMeta({ free: null, week_minutes: null }, NOT_ELSEWHERE)).toBeNull()
  })

  it('buildCandidates words it from checked.cross_studio, for both audiences', () => {
    const unchecked = { ...ALL_CHECKED, cross_studio: false }
    const manager = Object.fromEntries(build({ checked: unchecked }).candidates.map((c) => [c.profile_id, c.reason]))
    expect(manager.ann).toBe('Free here · 4h of 39h this week')
    expect(manager.hal).toBe('Free here · No shifts this week')
    const colleague = build({ checked: unchecked, audience: 'colleague' }).candidates
    expect(colleague[0].reason).toBe('Free here then')
    expect(colleague.find((c) => c.profile_id === 'cat').reason).toBe('Working then')
  })
})

describe('buildCandidates — colleague (the coach asking for cover)', () => {
  it('free or working only, ranked on that alone: leave and availability cannot leak through the order', () => {
    const { candidates, untimed } = build({ audience: 'colleague' })
    expect(candidates.map((c) => c.profile_id)).toEqual(['ann', 'bob', 'dan', 'eve', 'fay', 'gus', 'hal', 'cat'])
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual(['free', 'full_name', 'profile_id', 'rank', 'reason', 'role', 'tier'])
    }
    expect(candidates[0].reason).toBe('Free then')
    expect(candidates[7]).toMatchObject({ profile_id: 'cat', free: false, reason: 'Working then', tier: 'blocked' })
    expect(untimed).toBe(0)
  })
})

// CANDIDATES.1 review 6 — a shift ending at midnight ('24:00', or '00:00'
// after a start) is judged on its own window for availability, not as a
// whole day: its effective end reads '00:00', which unavailableFor took for
// "no usable end".
describe('availability against a shift that ends at midnight', () => {
  const lateBlock = (end) => ({
    ...BLOCK, id: 'late', start_time: '22:00:00', end_time: end,
    shift_templates: { name: 'Late', start_time: '22:00:00', end_time: end, kind: 'class' },
  })
  const rule = (over) => ({ profile_id: 'eve', kind: 'weekly', weekday: 'wed', all_day: false, note: null, ...over })
  const eveOn = (block, rules) => buildCandidates({ block, checked: ALL_CHECKED, members: [M('eve', 'Eve')], rules }).candidates[0]

  for (const end of ['24:00:00', '00:00:00']) {
    it(`${end}: a morning rule does not touch it; an evening rule and an all-day rule do`, () => {
      expect(eveOn(lateBlock(end), [rule({ start_time: '09:00', end_time: '10:00' })]).unavailable).toBeNull()
      expect(eveOn(lateBlock(end), [rule({ start_time: '23:00', end_time: '23:30' })]).unavailable).toEqual({ summary: '11pm–11:30pm', detail: 'Wednesdays, 11pm–11:30pm' })
      expect(eveOn(lateBlock(end), [rule({ all_day: true, start_time: null, end_time: null })]).unavailable).toMatchObject({ summary: 'all day' })
      // A rule that ends as the shift starts is fine (overlap is strict).
      expect(eveOn(lateBlock(end), [rule({ start_time: '21:00', end_time: '22:00' })]).unavailable).toBeNull()
    })
  }
})

describe('candidateFacts', () => {
  it('no target window (a block without times): shift facts unknown, leave and availability judged on the day', () => {
    const f = candidateFacts({
      target: null, candidateRow: { profile_id: 'x', block_date: '2026-09-23' },
      leave: [{ type: 'sick', start_date: '2026-09-23', end_date: '2026-09-23' }],
      rules: [{ kind: 'weekly', weekday: 'wed', all_day: false, start_time: '18:00', end_time: '19:00' }],
      checked: ALL_CHECKED,
    })
    expect(f).toMatchObject({ free: null, week_minutes: null, on_leave: { label: 'Sick leave' }, unavailable: { summary: '6pm–7pm' } })
    expect(f.on_leave).not.toHaveProperty('type')
  })
})

describe('QUALS.1 — qualification gaps', () => {
  const GAP = [{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }]

  it('a gap is one warn badge, after the others', () => {
    expect(candidateBadges({ free: true, qualification_gaps: GAP })).toEqual([{
      key: 'qualifications', tone: 'warn', text: 'First aid: not on record',
      title: 'This shift asks for First aid (not on record). Advisory only: you can still assign them.',
    }])
    const withRest = candidateBadges({ rest_gap: { rest_minutes: 600, other: {} }, qualification_gaps: GAP })
    expect(withRest.map((b) => b.key)).toEqual(['rest', 'qualifications'])
    expect(candidateBadges({ free: true, qualification_gaps: [] })).toEqual([])
  })

  it('never changes the tier, the order or the phone\'s reason line', () => {
    expect(candidateTier({ free: true, qualification_gaps: GAP })).toBe('ready')
    const ranked = rankCandidates([
      { profile_id: 'a', full_name: 'Abe', free: true, week_minutes: 0, qualification_gaps: GAP },
      { profile_id: 'b', full_name: 'Bea', free: true, week_minutes: 0 },
    ])
    expect(ranked.map((c) => c.profile_id)).toEqual(['a', 'b'])
    expect(ranked[0].reason).toBe(candidateReason({ free: true, week_minutes: 0 }))
  })

  it('an unread qualification check is named in the note', () => {
    expect(candidatesUncheckedNote({ qualifications: false })).toBe('Could not check qualifications, so the order may be off.')
  })
})
