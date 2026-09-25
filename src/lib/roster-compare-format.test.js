// src/lib/roster-compare-format.test.js
// SNAPSHOT.1 — the "Published vs now" words. Pure; run under two host zones.

import { describe, it, expect } from 'vitest'
import {
  COMPARE_CHANGE_LABELS, COMPARE_CHANGE_CHIP, dayLabel, periodLabel, publishedLabel, windowLabel,
  hoursLabel, deltaLabel, totalsSentence, changeCountsSentence, arrivalSentence, compareRowSummary,
  arrivalLabel, blockChangeNotes, missingSnapshotMessage, publishOptionLabel, publishedRosterIdsIn,
  visibleCompareBlocks,
} from './roster-compare-format'

const row = (over = {}) => ({
  profile_id: 'p1', name: 'Coach A', change: 'unchanged',
  published: { start: '06:00', end: '07:00' }, current: { start: '06:00', end: '07:00' },
  arrived_at: null, arrived_local: null, arrival_inferred: false, ended: true, no_show_candidate: false, ...over,
})

describe('labels', () => {
  it('names every change class, with a house-rule chip for each', () => {
    expect(COMPARE_CHANGE_LABELS).toEqual({
      unchanged: 'Unchanged', moved: 'Moved', added: 'Added after publish', removed: 'Removed after publish',
    })
    for (const cls of Object.values(COMPARE_CHANGE_CHIP)) expect(cls).toMatch(/^bg-[a-z]+-500\/10 text-[a-z]+-700$/)
  })

  it('days, periods and publish instants, whatever the host zone', () => {
    expect(dayLabel('2026-09-15')).toBe('Tue 15 Sep')
    expect(dayLabel('nope')).toBe('')
    expect(periodLabel('2026-09-14', '2026-09-20')).toBe('Mon 14 Sep – Sun 20 Sep')
    expect(periodLabel('2026-09-14', '2026-09-14')).toBe('Mon 14 Sep')
    // BST in September, GMT in December.
    expect(publishedLabel('2026-09-12T13:02:00Z')).toBe('Sat 12 Sep, 14:02')
    expect(publishedLabel('2026-12-01T09:05:00+00:00')).toBe('Tue 1 Dec, 09:05')
    expect(publishedLabel(null)).toBe('')
  })

  it('windows and hours', () => {
    expect(windowLabel({ start: '06:00', end: '07:00' })).toBe('06:00–07:00')
    expect(windowLabel(null)).toBe('—')
    expect(hoursLabel(3)).toBe('3.0h')
    expect(hoursLabel(1.25)).toBe('1.3h')
    expect(deltaLabel(-1.5)).toBe('−1.5h')
    expect(deltaLabel(2)).toBe('+2.0h')
    expect(deltaLabel(0.04)).toBe('no change')
  })
})

describe('sentences', () => {
  const t = {
    published_shifts: 3, published_hours: 3, current_shifts: 2, current_hours: 1.5, hours_delta: -1.5,
    unchanged: 1, moved: 1, added: 0, removed: 1, ended: 2, arrived: 1, arrived_inferred: 0, no_show_candidates: 1,
  }

  it('totals: published hours against now', () => {
    expect(totalsSentence(t)).toBe('Published 3.0h · now 1.5h (−1.5h)')
  })

  it('change counts name only what happened', () => {
    expect(changeCountsSentence(t)).toBe('1 moved · 1 removed after publish')
    expect(changeCountsSentence({ ...t, moved: 0, removed: 0 })).toBe('No coach changes since this publish')
  })

  it('arrivals count ended shifts only, and say when one was carried over', () => {
    expect(arrivalSentence(t)).toBe('Arrival recorded for 1 of 2 ended shifts')
    expect(arrivalSentence({ ...t, ended: 1, arrived: 1, arrived_inferred: 1 }))
      .toBe('Arrival recorded for 1 of 1 ended shift (1 carried from the shift before)')
    expect(arrivalSentence({ ...t, ended: 0 })).toBeNull()
    expect(arrivalSentence(null)).toBeNull()
  })

  it('a row says what happened to that coach', () => {
    expect(compareRowSummary(row({ change: 'moved', current: { start: '06:30', end: '07:00' } }))).toBe('06:00–07:00 → 06:30–07:00')
    expect(compareRowSummary(row({ change: 'removed', current: null }))).toBe('was 06:00–07:00')
    expect(compareRowSummary(row({ change: 'added', published: null }))).toBe('now 06:00–07:00')
    expect(compareRowSummary(row())).toBe('06:00–07:00')
  })

  it("arrival: the time, a carried arrival, 'no arrival recorded' only once ended, else nothing", () => {
    expect(arrivalLabel(row({ arrived_local: '05:58' }))).toBe('Arrived 05:58')
    expect(arrivalLabel(row({ arrived_local: '05:55', arrival_inferred: true }))).toBe('Arrived 05:55 (on site from the shift before)')
    expect(arrivalLabel(row({ no_show_candidate: true }))).toBe('No arrival recorded')
    expect(arrivalLabel(row({ ended: false }))).toBeNull()
  })

  it('block notes: moved, added, removed, and a changed minimum or maximum', () => {
    const b = { change: 'unchanged', staffing_changed: false, published: { start: '06:00', end: '07:00', min: 1, max: 2 }, current: { start: '06:00', end: '07:00', min: 1, max: 2 } }
    expect(blockChangeNotes(b)).toEqual([])
    expect(blockChangeNotes({ ...b, change: 'moved' })).toEqual(['Shift moved from 06:00–07:00'])
    expect(blockChangeNotes({ ...b, change: 'added', published: null })).toEqual(['Shift added after publish'])
    expect(blockChangeNotes({ ...b, change: 'removed', current: null })).toEqual(['Shift removed after publish'])
    expect(blockChangeNotes({ ...b, staffing_changed: true, current: { ...b.current, min: 2, max: 3 } }))
      .toEqual(['Coaches needed 1–2, now 2–3'])
  })

  it("block notes: the briefing (BLOCKEDIT.1) in the change log's own words, never its text", () => {
    const b = { change: 'unchanged', staffing_changed: false, published: { start: '06:00', end: '07:00', min: 1, max: 2 }, current: { start: '06:00', end: '07:00', min: 1, max: 2 } }
    expect(blockChangeNotes({ ...b, briefing_change: 'added' })).toEqual(['Briefing added after publish'])
    expect(blockChangeNotes({ ...b, briefing_change: 'changed' })).toEqual(['Briefing changed after publish'])
    expect(blockChangeNotes({ ...b, briefing_change: 'removed' })).toEqual(['Briefing removed after publish'])
    expect(blockChangeNotes({ ...b, briefing_change: null })).toEqual([])
    expect(blockChangeNotes({ ...b, change: 'moved', briefing_change: 'changed' }))
      .toEqual(['Shift moved from 06:00–07:00', 'Briefing changed after publish'])
  })
})

describe('missing snapshots (no backfill)', () => {
  it('before snapshots began at this studio: names the first date', () => {
    expect(missingSnapshotMessage({ missing_reason: 'before_snapshots', snapshots_began_at: '2026-09-26T08:00:00+00:00' }))
      .toBe('Published vs now is available for rosters published from Sat 26 Sep. This roster was published before then.')
  })
  it('no snapshot at the studio yet', () => {
    expect(missingSnapshotMessage({ missing_reason: 'before_snapshots', snapshots_began_at: null }))
      .toBe('Published vs now starts with the next publish at this studio. Rosters published before it have no record of what was published.')
  })
  it('a baseline whose dates miss the period on screen (review 3)', () => {
    expect(missingSnapshotMessage({ missing_reason: 'outside_window' }))
      .toBe('This publish does not cover the days on screen, so there is nothing to compare here.')
  })
  it('one should exist and was not saved', () => {
    expect(missingSnapshotMessage({ missing_reason: 'not_saved' })).toMatch(/could not be saved at the time/)
  })
})

describe('publishOptionLabel', () => {
  it('names the publish, its period, and which one is this roster', () => {
    const p = { snapshot_id: 's1', roster_id: 'r1', published_at: '2026-09-12T13:02:00Z', period_start: '2026-09-14', period_end: '2026-09-20' }
    expect(publishOptionLabel(p, 'r1')).toBe('Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep (this roster)')
    expect(publishOptionLabel(p, 'r2')).toBe('Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep')
  })
})

describe('publishedRosterIdsIn', () => {
  it('the published rosters the period sits on, earliest first; drafts, superseded and out-of-period blocks ignored', () => {
    const blocks = [
      { block_date: '2026-09-30', roster_id: 'r-oct', rosters: { status: 'published' } },
      { block_date: '2026-09-28', roster_id: 'r-sep', rosters: { status: 'published' } },
      { block_date: '2026-09-29', roster_id: 'r-sep', rosters: { status: 'published' } },
      { block_date: '2026-09-29', roster_id: 'r-old', rosters: { status: 'superseded' } },
      { block_date: '2026-09-29', roster_id: null, rosters: null },
      { block_date: '2026-10-05', roster_id: 'r-next', rosters: { status: 'published' } },
    ]
    expect(publishedRosterIdsIn(blocks, '2026-09-28', '2026-10-04')).toEqual(['r-sep', 'r-oct'])
    expect(publishedRosterIdsIn([], '2026-09-28', '2026-10-04')).toEqual([])
    expect(publishedRosterIdsIn(null, '2026-09-28', '2026-10-04')).toEqual([])
  })
})

describe('visibleCompareBlocks', () => {
  const quiet = { slot: 'q', change: 'unchanged', staffing_changed: false, coaches: [row()] }
  const busy = { slot: 'b', change: 'unchanged', staffing_changed: false, coaches: [row(), row({ profile_id: 'p2', change: 'moved' })] }
  const flagged = { slot: 'f', change: 'unchanged', staffing_changed: false, coaches: [row({ no_show_candidate: true })] }
  const gone = { slot: 'g', change: 'removed', staffing_changed: false, coaches: [] }

  it('hides unchanged shifts and unchanged coaches by default; keeps flags and block changes', () => {
    const out = visibleCompareBlocks([quiet, busy, flagged, gone], false)
    expect(out.map((b) => b.slot)).toEqual(['b', 'f', 'g'])
    expect(out[0].coaches.map((c) => c.profile_id)).toEqual(['p2'])
  })

  it('a briefing changed after publish keeps an otherwise quiet shift on the list', () => {
    const briefed = { ...quiet, slot: 'br', briefing_change: 'changed' }
    const out = visibleCompareBlocks([quiet, briefed], false)
    expect(out.map((b) => [b.slot, b.coaches.length])).toEqual([['br', 0]])
  })

  it('shows everything when asked', () => {
    expect(visibleCompareBlocks([quiet, busy], true).map((b) => [b.slot, b.coaches.length])).toEqual([['q', 1], ['b', 2]])
  })
})
