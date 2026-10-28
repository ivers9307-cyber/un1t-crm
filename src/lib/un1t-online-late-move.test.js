// UN1TMOVE.2 — the late-window move rule's pure day test and its ledger read.
import { describe, it, expect } from 'vitest'
import { sameStudioDay, wasMovedInLateWindow, UN1T_LATE_MOVE_CODES } from './un1t-online-late-move.js'
import { makeDb, LOC } from './un1t-online-write.test-helpers.js'

describe('sameStudioDay', () => {
  it("compares calendar days on the studio's clock, never UTC", () => {
    // 23:30 UTC on 28 Oct is 23:30 in Dublin (winter): the same Dublin day as 08:00.
    expect(sameStudioDay('2026-10-28T08:00:00Z', '2026-10-28T23:30:00Z', 'Europe/Dublin')).toBe(true)
    // In summer 23:30 UTC is 00:30 the next Dublin day.
    expect(sameStudioDay('2026-07-01T08:00:00Z', '2026-07-01T23:30:00Z', 'Europe/Dublin')).toBe(false)
    // New York: 03:00 UTC is still the previous local day.
    expect(sameStudioDay('2026-10-28T03:00:00Z', '2026-10-27T20:00:00Z', 'America/New_York')).toBe(true)
    expect(sameStudioDay('2026-10-28T03:00:00Z', 'nonsense', 'Europe/Dublin')).toBe(false)
  })
})

describe('wasMovedInLateWindow', () => {
  const row = (over) => ({ id: 'w', location_id: LOC, op: 'move', late_window: true, stage: 'done', target: 'bk-1', un1t_ref: 'bk-1', ...over })
  it('a late-window move of the booking, done, in flight or in doubt, holds it; by target or by the answered id', async () => {
    for (const r of [row(), row({ stage: 'sent', un1t_ref: null }), row({ stage: 'unknown', un1t_ref: null }), row({ target: 'bk-0', un1t_ref: 'bk-1' })]) {
      const { db } = makeDb({ tables: { un1t_write_events: [r] } })
      expect(await wasMovedInLateWindow(db, { locationId: LOC, bookingId: 'bk-1' }), JSON.stringify(r)).toBe(true)
    }
  })
  it('a refused move, a move outside the window, another booking, studio or op does not', async () => {
    for (const r of [row({ stage: 'refused' }), row({ late_window: false }), row({ target: 'bk-2', un1t_ref: 'bk-2' }), row({ location_id: 'elsewhere' }), row({ op: 'cancel' })]) {
      const { db } = makeDb({ tables: { un1t_write_events: [r] } })
      expect(await wasMovedInLateWindow(db, { locationId: LOC, bookingId: 'bk-1' }), JSON.stringify(r)).toBe(false)
    }
  })
  it('a failed read throws (every cancel path then refuses)', async () => {
    const { db } = makeDb({ fail: { 'un1t_write_events.select': { code: 'XX000' } } })
    await expect(wasMovedInLateWindow(db, { locationId: LOC, bookingId: 'bk-1' })).rejects.toThrow(/late-move read failed/)
    expect(UN1T_LATE_MOVE_CODES.CANCEL_AFTER_LATE_MOVE).toBe('cancel_after_late_move')
  })
})
