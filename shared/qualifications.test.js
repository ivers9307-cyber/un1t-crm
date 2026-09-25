// QUALS.1 — the pure qualification rules. No clock, no database, no host
// timezone: run under TZ=Europe/Dublin AND a US zone.

import { describe, it, expect } from 'vitest'
import {
  QUALIFICATION_EXPIRY_WINDOW_DAYS, QUALIFICATION_STATUSES, QUALIFICATION_STATUS_TONES,
  qualificationDaysUntil, formatQualificationDate, qualificationStatus, qualificationStatusLabel,
  personNeedsAttention, requirementGaps, qualificationGapBadge, attachQualificationGaps,
  digestRows, digestHeadline, parseTemplateQualificationsAnswer,
} from './qualifications.js'

const TODAY = '2026-09-28'
const rec = (expires_on, over = {}) => ({ id: 'r', profile_id: 'p', qualification_type_id: 'fa', expires_on, ...over })

describe('qualificationDaysUntil and formatQualificationDate', () => {
  it('whole calendar days, across month, year, leap-day and DST boundaries', () => {
    expect(qualificationDaysUntil('2026-09-28', '2026-09-28')).toBe(0)
    expect(qualificationDaysUntil('2026-09-28', '2026-10-28')).toBe(30)
    expect(qualificationDaysUntil('2026-10-24', '2026-10-26')).toBe(2) // Irish clocks go back on 25 Oct
    expect(qualificationDaysUntil('2027-03-27', '2027-03-29')).toBe(2) // and forward on 28 Mar 2027
    expect(qualificationDaysUntil('2026-12-31', '2027-01-01')).toBe(1)
    expect(qualificationDaysUntil('2026-09-28', '2026-09-27')).toBe(-1)
    expect(qualificationDaysUntil('2028-02-28', '2028-03-01')).toBe(2)
  })

  it('an unreadable date is null, never a number', () => {
    expect(qualificationDaysUntil('2026-02-30', '2026-03-01')).toBeNull()
    expect(qualificationDaysUntil('28/09/2026', '2026-10-01')).toBeNull()
    expect(qualificationDaysUntil(null, '2026-10-01')).toBeNull()
  })

  it("formats as '31 Aug 2026', or '' when unreadable", () => {
    expect(formatQualificationDate('2026-08-31')).toBe('31 Aug 2026')
    expect(formatQualificationDate('2027-01-05')).toBe('5 Jan 2027')
    expect(formatQualificationDate('2026-13-01')).toBe('')
    expect(formatQualificationDate(undefined)).toBe('')
  })
})

describe('qualificationStatus', () => {
  it('missing, expired, expiring (the day up to 30 days ahead), valid; no expiry is valid', () => {
    expect(QUALIFICATION_EXPIRY_WINDOW_DAYS).toBe(30)
    expect(QUALIFICATION_STATUSES).toEqual(['valid', 'expiring', 'expired', 'missing'])
    expect(qualificationStatus(null, TODAY)).toBe('missing')
    expect(qualificationStatus(rec('2026-09-27'), TODAY)).toBe('expired')
    expect(qualificationStatus(rec('2026-09-28'), TODAY)).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-28'), TODAY)).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-29'), TODAY)).toBe('valid')
    expect(qualificationStatus(rec(null), TODAY)).toBe('valid')
    expect(qualificationStatus(rec(''), TODAY)).toBe('valid')
  })

  it('takes a custom window', () => {
    expect(qualificationStatus(rec('2026-10-05'), TODAY, { windowDays: 7 })).toBe('expiring')
    expect(qualificationStatus(rec('2026-10-06'), TODAY, { windowDays: 7 })).toBe('valid')
  })

  it('an unreadable date is unknown (null): neither an all-clear nor an alarm', () => {
    expect(qualificationStatus(rec('2026-02-30'), TODAY)).toBeNull()
    expect(qualificationStatus(rec('2026-10-01'), 'not a day')).toBeNull()
  })

  it('tones follow the status', () => {
    expect(QUALIFICATION_STATUS_TONES).toEqual({ valid: 'good', expiring: 'warn', expired: 'bad', missing: 'muted' })
  })
})

describe('qualificationStatusLabel', () => {
  it('says what a manager needs to know', () => {
    expect(qualificationStatusLabel(null, TODAY)).toBe('Not on record')
    expect(qualificationStatusLabel(rec(null), TODAY)).toBe('No expiry')
    expect(qualificationStatusLabel(rec('2026-09-27'), TODAY)).toBe('Expired yesterday (27 Sep 2026)')
    expect(qualificationStatusLabel(rec('2026-08-31'), TODAY)).toBe('Expired 31 Aug 2026')
    expect(qualificationStatusLabel(rec('2026-09-28'), TODAY)).toBe('Expires today')
    expect(qualificationStatusLabel(rec('2026-09-29'), TODAY)).toBe('Expires tomorrow')
    expect(qualificationStatusLabel(rec('2026-10-20'), TODAY)).toBe('Expires in 22 days (20 Oct 2026)')
    expect(qualificationStatusLabel(rec('2027-03-01'), TODAY)).toBe('Valid until 1 Mar 2027')
    expect(qualificationStatusLabel(rec('2026-02-30'), TODAY)).toBe('Expiry date unreadable')
  })
})

describe('personNeedsAttention', () => {
  it('true when a record is expired or expiring; missing and unreadable are not "attention"', () => {
    expect(personNeedsAttention([rec('2027-03-01'), rec(null)], TODAY)).toBe(false)
    expect(personNeedsAttention([rec('2027-03-01'), rec('2026-10-01')], TODAY)).toBe(true)
    expect(personNeedsAttention([rec('2026-01-01')], TODAY)).toBe(true)
    expect(personNeedsAttention([rec('2026-02-30')], TODAY)).toBe(false)
    expect(personNeedsAttention([], TODAY)).toBe(false)
    expect(personNeedsAttention(undefined, TODAY)).toBe(false)
  })
})

describe('requirementGaps — judged on the SHIFT date', () => {
  const REQUIRED = [{ id: 'ins', name: 'Insurance' }, { id: 'fa', name: 'First aid' }]

  it('missing and expired are gaps; a certificate expiring on the shift day covers it; sorted by name', () => {
    const records = [rec('2026-10-10', { qualification_type_id: 'fa' })]
    expect(requirementGaps({ required: REQUIRED, records, onISO: '2026-10-10' })).toEqual([
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])
    expect(requirementGaps({ required: REQUIRED, records, onISO: '2026-10-11' })).toEqual([
      { type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-10-10' },
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])
  })

  it('no requirement, no gap; no expiry covers; an unreadable record is not a gap (unknown is neutral)', () => {
    const FA = [{ id: 'fa', name: 'First aid' }]
    expect(requirementGaps({ required: [], records: [], onISO: TODAY })).toEqual([])
    expect(requirementGaps({ required: FA, records: [rec(null)], onISO: TODAY })).toEqual([])
    expect(requirementGaps({ required: FA, records: [rec('2026-02-30')], onISO: TODAY })).toEqual([])
  })
})

describe('qualificationGapBadge', () => {
  it('one gap names it; several are counted; the title lists every one and says advisory', () => {
    expect(qualificationGapBadge([])).toBeNull()
    expect(qualificationGapBadge(undefined)).toBeNull()
    expect(qualificationGapBadge([{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }])).toEqual({
      key: 'qualifications', tone: 'warn', text: 'First aid: not on record',
      title: 'This shift asks for First aid (not on record). Advisory only: you can still assign them.',
    })
    expect(qualificationGapBadge([{ type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-08-31' }]).text)
      .toBe('First aid: expired')
    expect(qualificationGapBadge([
      { type_id: 'fa', name: 'First aid', status: 'expired', expires_on: '2026-08-31' },
      { type_id: 'ins', name: 'Insurance', status: 'missing', expires_on: null },
    ])).toEqual({
      key: 'qualifications', tone: 'warn', text: '2 qualifications missing or expired',
      title: 'This shift asks for First aid (expired 31 Aug 2026) and Insurance (not on record). Advisory only: you can still assign them.',
    })
  })
})

describe('attachQualificationGaps', () => {
  it('adds qualification_gaps to copies; with nothing required, the same list comes back', () => {
    const list = [{ profile_id: 'a', rank: 1 }, { profile_id: 'b', rank: 2 }]
    expect(attachQualificationGaps(list, { required: [], records: [], onISO: TODAY })).toBe(list)
    const out = attachQualificationGaps(list, {
      required: [{ id: 'fa', name: 'First aid' }],
      records: [{ profile_id: 'a', qualification_type_id: 'fa', expires_on: '2027-01-01' }],
      onISO: TODAY,
    })
    expect(out).toEqual([
      { profile_id: 'a', rank: 1, qualification_gaps: [] },
      { profile_id: 'b', rank: 2, qualification_gaps: [{ type_id: 'fa', name: 'First aid', status: 'missing', expires_on: null }] },
    ])
    expect(list[0]).not.toHaveProperty('qualification_gaps')
  })
})

describe('digestRows and digestHeadline', () => {
  const PEOPLE = [{ profile_id: 'ann', full_name: 'Ann' }, { profile_id: 'bob', full_name: 'Bob' }]
  const TYPES = [
    { id: 'fa', name: 'First aid', active: true },
    { id: 'ins', name: 'Insurance', active: true },
    { id: 'old', name: 'Old cert', active: false },
  ]
  const RECORDS = [
    { profile_id: 'bob', qualification_type_id: 'fa', expires_on: '2026-10-05' },
    { profile_id: 'ann', qualification_type_id: 'ins', expires_on: '2026-10-20' },
    { profile_id: 'ann', qualification_type_id: 'fa', expires_on: '2026-09-20' },
    { profile_id: 'ann', qualification_type_id: 'old', expires_on: '2026-09-01' }, // archived type
    { profile_id: 'zed', qualification_type_id: 'fa', expires_on: '2026-09-01' }, // not one of these people
    { profile_id: 'bob', qualification_type_id: 'ins', expires_on: '2027-06-01' }, // valid
  ]

  it('expired first (oldest first), then expiring (soonest first); archived types and outsiders left out', () => {
    expect(digestRows({ people: PEOPLE, types: TYPES, records: RECORDS, todayISO: TODAY })).toEqual([
      { profile_id: 'ann', full_name: 'Ann', type_id: 'fa', type_name: 'First aid', expires_on: '2026-09-20', status: 'expired', days: -8 },
      { profile_id: 'bob', full_name: 'Bob', type_id: 'fa', type_name: 'First aid', expires_on: '2026-10-05', status: 'expiring', days: 7 },
      { profile_id: 'ann', full_name: 'Ann', type_id: 'ins', type_name: 'Insurance', expires_on: '2026-10-20', status: 'expiring', days: 22 },
    ])
  })

  it('the headline counts, singular and plural, or is null with nothing to say', () => {
    const rows = digestRows({ people: PEOPLE, types: TYPES, records: RECORDS, todayISO: TODAY })
    expect(digestHeadline(rows)).toBe('1 qualification has expired and 2 more expire in the next 30 days.')
    expect(digestHeadline(rows.slice(0, 1))).toBe('1 qualification has expired.')
    expect(digestHeadline(rows.slice(1))).toBe('2 qualifications expire in the next 30 days.')
    expect(digestHeadline(rows.slice(2))).toBe('1 qualification expires in the next 30 days.')
    expect(digestHeadline([rows[0], rows[0], rows[1]])).toBe('2 qualifications have expired and 1 more expires in the next 30 days.')
    expect(digestHeadline([])).toBeNull()
  })
})

describe('parseTemplateQualificationsAnswer', () => {
  it('understands { types, requirements }; anything else (an older server, a test mock) is not understood', () => {
    expect(parseTemplateQualificationsAnswer(null)).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: false, error: 'x' })).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: true, data: [{ id: 't1' }] })).toEqual({ ok: false })
    expect(parseTemplateQualificationsAnswer({ success: true, data: {
      types: [{ id: 'fa', name: 'First aid', active: true }, { id: '', name: 'x' }, null],
      requirements: { t1: ['fa', 7], t2: 'junk' },
    } })).toEqual({ ok: true, types: [{ id: 'fa', name: 'First aid', active: true }], requirements: { t1: ['fa'] } })
  })
})
