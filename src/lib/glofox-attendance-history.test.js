// ATTHISTORY.1 — the pure half of the one-time Glofox history read.
import { describe, it, expect } from 'vitest'
import { historyPatch, historyHasAttendance, historyOutcome } from './glofox-attendance-history.js'

const sec = (iso) => Math.floor(Date.parse(iso) / 1000)
const booking = (iso, { attended = false, status = 'BOOKED' } = {}) => ({
  _id: `b-${iso}`, time_start: sec(iso), created: sec(iso), status, attended,
})
const NOW = new Date('2026-10-31T12:00:00Z')

describe('historyPatch', () => {
  it('always stamps the cursor, even when the read found nothing', () => {
    const patch = historyPatch({ id: 'c1', last_attended_at: null, last_booked_at: null }, [], NOW)
    expect(patch).toEqual({ glofox_history_synced_at: '2026-10-31T12:00:00.000Z' })
  })

  it('stamps the cursor on a FAILED read (null bookings) and touches nothing else', () => {
    const patch = historyPatch({ id: 'c1', last_attended_at: '2025-01-01T10:00:00.000Z' }, null, NOW)
    expect(patch).toEqual({ glofox_history_synced_at: '2026-10-31T12:00:00.000Z' })
  })

  it('fills last_attended_at and last_booked_at from a years-old history', () => {
    const patch = historyPatch(
      { id: 'c1', last_attended_at: null, last_booked_at: null },
      [booking('2024-03-04T07:00:00Z', { attended: true }), booking('2023-11-20T18:00:00Z', { attended: true })],
      NOW,
    )
    expect(patch.last_attended_at).toBe('2024-03-04T07:00:00.000Z')
    expect(patch.last_booked_at).toBe('2024-03-04T07:00:00.000Z')
    expect(patch.glofox_history_synced_at).toBe('2026-10-31T12:00:00.000Z')
  })

  it('never regresses a stored date (advance-only), and never writes the windowed counts', () => {
    const existing = { id: 'c1', last_attended_at: '2026-10-20T07:00:00.000Z', last_booked_at: '2026-10-28T07:00:00.000Z' }
    const patch = historyPatch(existing, [booking('2024-03-04T07:00:00Z', { attended: true })], NOW)
    expect(patch).toEqual({ glofox_history_synced_at: '2026-10-31T12:00:00.000Z' })
    expect(Object.keys(patch)).not.toContain('total_attended_30d')
    expect(Object.keys(patch)).not.toContain('total_bookings_30d')
  })

  it('a history of bookings that were never attended sets last_booked_at only', () => {
    const patch = historyPatch({ id: 'c1' }, [booking('2025-06-01T07:00:00Z', { attended: false })], NOW)
    expect(patch.last_booked_at).toBe('2025-06-01T07:00:00.000Z')
    expect(patch.last_attended_at).toBeUndefined()
  })
})

describe('historyHasAttendance', () => {
  it('is true only when some booking was attended', () => {
    expect(historyHasAttendance([booking('2025-06-01T07:00:00Z')])).toBe(false)
    expect(historyHasAttendance([booking('2025-06-01T07:00:00Z'), booking('2025-06-02T07:00:00Z', { attended: true })])).toBe(true)
    expect(historyHasAttendance(null)).toBe(false)
    expect(historyHasAttendance([])).toBe(false)
  })
})

describe('historyOutcome', () => {
  it('sums the studios and reports remaining as null when any count failed', () => {
    const out = historyOutcome([
      { status: 'completed', eligible: 600, remaining: 4000, summary: { read: 590, no_bookings: 300, attended: 250, truncated: 1, fetch_failed: 10, update_failed: 0 } },
      { status: 'failed', eligible: 0, remaining: null, summary: { read: 0, no_bookings: 0, attended: 0, truncated: 0, fetch_failed: 0, update_failed: 0 } },
    ], true, { calls: 1200 }, { skipped_locations: 0 })
    expect(out).toMatchObject({
      eligible: 600, read: 590, no_bookings: 300, attended: 250, truncated: 1, fetch_failed: 10, update_failed: 0,
      failed_locations: 1, remaining: null, budget_exhausted: true, glofox_http: { calls: 1200 }, skipped_locations: 0,
    })
  })

  it('adds remaining across studios when every count answered', () => {
    const out = historyOutcome([
      { status: 'completed', eligible: 1, remaining: 10, summary: {} },
      { status: 'completed', eligible: 2, remaining: 5, summary: {} },
    ], false, {})
    expect(out.remaining).toBe(15)
    expect(out.eligible).toBe(3)
  })
})
