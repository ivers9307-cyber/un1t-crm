// src/lib/roster-change-format.test.js
// CHANGELOG.1 — one roster_change_log row as a sentence a manager can read.
// Pure. Host-TZ independent; run under both:
//   for tz in Europe/Dublin America/Los_Angeles; do
//     TZ=$tz npx vitest run src/lib/roster-change-format.test.js
//   done
import { describe, it, expect } from 'vitest'
import {
  rosterChangeSentence, rosterChangeTold, rosterChangeByline, formatRosterChange,
} from './roster-change-format'

// Tue 15 Sep 2026. 13:02Z is 14:02 in Dublin (summer time, UTC+1).
const row = (over = {}) => ({
  id: 'c1', action: 'assigned', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_name: 'Coach A', actor_name: 'Manager B', details: {},
  notified_at: '2026-09-15T13:02:00Z', created_at: '2026-09-15T12:58:00Z', ...over,
})

describe('rosterChangeSentence', () => {
  it('assigned', () => {
    expect(rosterChangeSentence(row())).toBe('Assigned Coach A to Tue 15 Sep 06:00')
  })

  it('unassigned', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned' }))).toBe('Removed Coach A from Tue 15 Sep 06:00')
  })

  it('says how it happened when the writer recorded it', () => {
    expect(rosterChangeSentence(row({ details: { via: 'copy_week' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 (copied from another week)')
    expect(rosterChangeSentence(row({ details: { via: 'copy_month' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 (copied from another month)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap', swap_id: 's1', effect: 'approved_reassign' } })))
      .toBe('Removed Coach A from Tue 15 Sep 06:00 (shift swap)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap_drop', swap_id: 's1' } })))
      .toBe('Removed Coach A from Tue 15 Sep 06:00 (dropped shift approved)')
  })

  it('a deleted slot has no block left to read a time from: the date alone', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned', start_time: null, end_time: null, details: { via: 'slot_deleted' } })))
      .toBe('Removed Coach A from Tue 15 Sep (slot deleted)')
  })

  it('time_changed from the assignment editor: the hours the coach now has', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: '06:30:00', end_time_override: null } })))
      .toBe("Changed Coach A's hours on Tue 15 Sep 06:00 to 06:30–07:00")
  })

  it('time_changed with both overrides cleared is a reset', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: null, end_time_override: null } })))
      .toBe("Reset Coach A's hours on Tue 15 Sep 06:00 to the shift's own")
  })

  it('time_changed from a template edit names the OLD time, because the block now holds the new one', () => {
    expect(rosterChangeSentence(row({
      action: 'time_changed', start_time: '06:30:00', end_time: '07:30:00',
      details: { source: 'template_edit', template_id: 't1', from: { start_time: '06:00:00', end_time: '07:00:00' }, to: { start_time: '06:30:00', end_time: '07:30:00' } },
    }))).toBe("Moved Coach A's Tue 15 Sep 06:00 shift to 06:30–07:30 (template edited)")
  })

  it('time_changed with details it does not recognise still says something true', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: {} }))).toBe("Changed Coach A's hours on Tue 15 Sep 06:00")
  })

  it('never invents a name, a date or an action', () => {
    expect(rosterChangeSentence(row({ coach_name: null }))).toBe('Assigned a coach to Tue 15 Sep 06:00')
    expect(rosterChangeSentence(row({ block_date: null, start_time: null }))).toBe('Assigned Coach A to a shift')
    expect(rosterChangeSentence(row({ action: 'mystery' }))).toBe("Changed Coach A's shift on Tue 15 Sep 06:00")
    expect(rosterChangeSentence(row({ details: { via: 'something_new' } }))).toBe('Assigned Coach A to Tue 15 Sep 06:00')
    expect(rosterChangeSentence(row({ details: null }))).toBe('Assigned Coach A to Tue 15 Sep 06:00')
  })

  it('reads the weekday off the calendar date, whatever the host timezone', () => {
    expect(rosterChangeSentence(row({ block_date: '2026-03-29' }))).toMatch(/Sun 29 Mar/) // spring DST day
    expect(rosterChangeSentence(row({ block_date: '2026-10-25' }))).toMatch(/Sun 25 Oct/) // autumn DST day
    expect(rosterChangeSentence(row({ block_date: '2026-12-14' }))).toMatch(/Mon 14 Dec/)
  })
})

describe('rosterChangeTold', () => {
  it('told, with the Dublin wall-clock time', () => {
    expect(rosterChangeTold(row())).toBe('told 14:02')
  })
  it('winter: Dublin is UTC, no shift', () => {
    expect(rosterChangeTold(row({ notified_at: '2026-12-01T14:02:00Z', created_at: '2026-12-01T09:00:00Z' }))).toBe('told 14:02')
  })
  it('names the day when the coach was told on a later day than the change', () => {
    expect(rosterChangeTold(row({ notified_at: '2026-09-17T08:05:00Z' }))).toBe('told 17 Sep 09:05')
  })
  it('a change at 23:30 Dublin told at 00:10 Dublin is a later DAY, even though UTC calls it the same day', () => {
    // 22:30Z = 23:30 Dublin on the 15th; 23:10Z = 00:10 Dublin on the 16th.
    expect(rosterChangeTold(row({ created_at: '2026-09-15T22:30:00Z', notified_at: '2026-09-15T23:10:00Z' }))).toBe('told 16 Sep 00:10')
  })
  it('not told yet', () => {
    expect(rosterChangeTold(row({ notified_at: null }))).toBe('not told yet')
  })
  it('an unreadable stamp is "told", never a crash or a made-up time', () => {
    expect(rosterChangeTold(row({ notified_at: 'garbage' }))).toBe('told')
  })
})

describe('rosterChangeByline', () => {
  it('who and when, in Dublin time', () => {
    expect(rosterChangeByline(row())).toBe('Manager B · 15 Sep 13:58')
  })
  it('a change with no actor (a deleted profile, or a system path) says so', () => {
    expect(rosterChangeByline(row({ actor_name: null }))).toBe('System · 15 Sep 13:58')
  })
  it('an unreadable created_at leaves the name alone', () => {
    expect(rosterChangeByline(row({ created_at: null }))).toBe('Manager B')
  })
})

describe('formatRosterChange', () => {
  it('is the sentence and the told state in one line', () => {
    expect(formatRosterChange(row())).toBe('Assigned Coach A to Tue 15 Sep 06:00 · told 14:02')
    expect(formatRosterChange(row({ notified_at: null }))).toBe('Assigned Coach A to Tue 15 Sep 06:00 · not told yet')
  })
})
