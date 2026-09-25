// ICSFEED.1 — which shifts become calendar events, and at what instant.
// Run this file under two machine time zones (see Step 4): nothing here may
// depend on the machine's clock zone, only on the studio's.

import { describe, it, expect } from 'vitest'
import {
  FEED_DAYS_BACK, FEED_DAYS_AHEAD, feedWindow, wallInstant, isPublishedLiveRow,
  shiftToFeedEvent, buildStaffShiftFeed,
} from './staff-calendar-feed'

const STUDIO = { id: 'loc-1', name: 'Studio One', address: '1 Example Street, Dublin', timezone: 'Europe/Dublin' }
const NYC = { id: 'loc-9', name: 'Studio Nine', address: null, timezone: 'America/New_York' }
const GEN = Date.UTC(2026, 8, 25, 10, 0)

function row(over = {}, block = {}) {
  return {
    id: 'a1', status: 'scheduled', start_time_override: null, end_time_override: null,
    updated_at: '2026-09-20T10:00:00.000Z',
    ...over,
    shift_blocks: {
      location_id: 'loc-1', block_date: '2026-09-28', start_time: '06:00:00', end_time: '07:00:00',
      updated_at: '2026-09-21T08:15:00+00:00',
      rosters: { status: 'published' },
      shift_templates: { name: 'Morning' },
      ...block,
    },
  }
}

const unfoldedLines = (ics) => ics.replace(/\r\n /g, '').split('\r\n')

describe('feedWindow — two weeks back, eight ahead (00-INDEX default 5)', () => {
  it('is Dublin today −14 to +56', () => {
    expect(FEED_DAYS_BACK).toBe(14)
    expect(FEED_DAYS_AHEAD).toBe(56)
    expect(feedWindow('2026-09-25')).toEqual({ from: '2026-09-11', to: '2026-11-20' })
  })
})

describe('wallInstant — studio wall clock to UTC, DST-correct', () => {
  it('Irish Summer Time is UTC+1, Irish winter time is UTC+0', () => {
    expect(wallInstant('2026-09-28', '06:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 8, 28, 5, 0))
    expect(wallInstant('2026-12-01', '06:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 11, 1, 6, 0))
  })
  it('either side of the 2026 transitions (29 March, 25 October)', () => {
    expect(wallInstant('2026-03-28', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 2, 28, 6, 0))
    expect(wallInstant('2026-03-30', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 2, 30, 5, 0))
    expect(wallInstant('2026-10-24', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 24, 5, 0))
    expect(wallInstant('2026-10-26', '06:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 26, 6, 0))
  })
  it("'24:00' is the next day's midnight in the studio's zone", () => {
    expect(wallInstant('2026-10-26', '24:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 9, 27, 0, 0))
    expect(wallInstant('2026-09-28', '24:00:00', 'Europe/Dublin')).toBe(Date.UTC(2026, 8, 28, 23, 0))
  })
  it('an unreadable time is null, never a guess', () => {
    expect(wallInstant('2026-09-28', null, 'Europe/Dublin')).toBe(null)
    expect(wallInstant('2026-09-28', '6am', 'Europe/Dublin')).toBe(null)
    expect(wallInstant('2026-02-30', '06:00', 'Europe/Dublin')).toBe(null)
  })
  it("a '24:00' end on a date that does not exist is null, not rolled into March", () => {
    expect(wallInstant('2026-02-30', '24:00:00', 'Europe/Dublin')).toBe(null)
  })
})

describe('isPublishedLiveRow — published and not cancelled, nothing else', () => {
  it('a published, scheduled shift qualifies', () => {
    expect(isPublishedLiveRow(row())).toBe(true)
    expect(isPublishedLiveRow(row({ status: 'confirmed' }))).toBe(true)
    expect(isPublishedLiveRow(row({ status: 'completed' }))).toBe(true)
  })
  it('draft, unpublished (no roster) and cancelled do not', () => {
    expect(isPublishedLiveRow(row({}, { rosters: { status: 'draft' } }))).toBe(false)
    expect(isPublishedLiveRow(row({}, { rosters: null }))).toBe(false)
    expect(isPublishedLiveRow(row({ status: 'cancelled' }))).toBe(false)
    expect(isPublishedLiveRow(null)).toBe(false)
    expect(isPublishedLiveRow({ id: 'x', status: 'scheduled' })).toBe(false)
  })
})

describe('shiftToFeedEvent', () => {
  it('maps a block shift: stable UID, UTC times, template · studio, studio + address', () => {
    expect(shiftToFeedEvent(row(), STUDIO, GEN)).toEqual({
      uid: 'shift-a1@repset.ie',
      dtstampMs: Date.parse('2026-09-21T08:15:00Z'),
      lastModifiedMs: Date.parse('2026-09-21T08:15:00Z'),
      startMs: Date.UTC(2026, 8, 28, 5, 0),
      endMs: Date.UTC(2026, 8, 28, 6, 0),
      summary: 'Morning · Studio One',
      location: 'Studio One, 1 Example Street, Dublin',
      description: 'Rostered shift, as published. Open the app for swaps and changes.',
    })
  })

  it("uses the coach's override where there is one (the effective time, not the block's)", () => {
    const e = shiftToFeedEvent(row({ start_time_override: '06:30:00', end_time_override: '06:45:00' }), STUDIO, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 5, 30))
    expect(e.endMs).toBe(Date.UTC(2026, 8, 28, 5, 45))
  })

  it('LAST-MODIFIED is the later of the assignment and the block, so a moved block counts', () => {
    const e = shiftToFeedEvent(row({ updated_at: '2026-09-24T12:00:00Z' }), STUDIO, GEN)
    expect(e.lastModifiedMs).toBe(Date.parse('2026-09-24T12:00:00Z'))
    expect(e.dtstampMs).toBe(e.lastModifiedMs)
  })

  it('with no readable updated_at, DTSTAMP falls back to the generation time and LAST-MODIFIED is left out', () => {
    const e = shiftToFeedEvent(row({ updated_at: null }, { updated_at: null }), STUDIO, GEN)
    expect(e.dtstampMs).toBe(GEN)
    expect(e.lastModifiedMs).toBe(null)
  })

  it("reads the studio's own zone", () => {
    const e = shiftToFeedEvent(row({}, { location_id: 'loc-9' }), NYC, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 10, 0))
    expect(e.location).toBe('Studio Nine')
  })

  it('an unknown zone or a missing studio row falls back to Dublin and a bare template name', () => {
    expect(shiftToFeedEvent(row(), { ...STUDIO, timezone: 'Mars/Base' }, GEN).startMs).toBe(Date.UTC(2026, 8, 28, 5, 0))
    const e = shiftToFeedEvent(row(), undefined, GEN)
    expect(e.startMs).toBe(Date.UTC(2026, 8, 28, 5, 0))
    expect(e.summary).toBe('Morning')
    expect(e.location).toBe(null)
  })

  it('an end at or before the start is dropped (the event ends at DTSTART), never written backwards', () => {
    expect(shiftToFeedEvent(row({ end_time_override: '05:00:00' }), STUDIO, GEN).endMs).toBe(null)
  })

  it('an unreadable start skips the shift', () => {
    expect(shiftToFeedEvent(row({}, { start_time: null }), STUDIO, GEN)).toBe(null)
  })
})

describe('buildStaffShiftFeed', () => {
  const LOCS = { 'loc-1': STUDIO }

  it('writes only published, live shifts, in start order', () => {
    const ics = buildStaffShiftFeed({
      rows: [
        row({ id: 'late' }, { block_date: '2026-09-29' }),
        row({ id: 'draft' }, { rosters: { status: 'draft' } }),
        row({ id: 'gone', status: 'cancelled' }),
        row({ id: 'early' }),
      ],
      locationsById: LOCS,
      generatedAtMs: GEN,
    })
    const uids = unfoldedLines(ics).filter((l) => l.startsWith('UID:'))
    expect(uids).toEqual(['UID:shift-early@repset.ie', 'UID:shift-late@repset.ie'])
  })

  it('names the calendar and asks for hourly refresh', () => {
    const lines = unfoldedLines(buildStaffShiftFeed({ rows: [], locationsById: {}, generatedAtMs: GEN }))
    expect(lines).toEqual(expect.arrayContaining([
      'PRODID:-//Repset//Staff shift feed//EN',
      'X-WR-CALNAME:Rostered shifts',
      'REFRESH-INTERVAL;VALUE=DURATION:PT60M',
    ]))
  })

  it("never writes an assignment's notes or partial reason (manager working notes, COACHSCOPE.1)", () => {
    const ics = buildStaffShiftFeed({
      rows: [row({ notes: 'PRIVATE NOTE', partial_reason: 'PRIVATE REASON' })],
      locationsById: LOCS,
      generatedAtMs: GEN,
    })
    expect(ics).not.toContain('PRIVATE')
  })

  it('is deterministic for a given roster (DTSTAMP is the revision time, not now)', () => {
    const a = buildStaffShiftFeed({ rows: [row()], locationsById: LOCS, generatedAtMs: GEN })
    const b = buildStaffShiftFeed({ rows: [row()], locationsById: LOCS, generatedAtMs: GEN + 3_600_000 })
    expect(a).toBe(b)
  })
})
