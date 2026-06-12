// TODAY-FEED.1 — tests for the pure "Needs attention" feed logic that
// powers the triage section of /dashboard/today (and, later, the
// mobile PersonalDashboard + the morning briefing digest). All pure:
// (raw data, nowMs) → rows. IO lives in src/lib/today-feed-data.js.

import { describe, it, expect } from 'vitest'
import {
  classifyLowFillClasses,
  churnSnapshotDelta,
  filterTasksDueToday,
  assembleTodayFeed,
  LOW_FILL_THRESHOLD,
} from './today-feed'

// 2026-06-12 10:00:00 UTC — a fixed "now" for every test.
const NOW = Date.UTC(2026, 5, 12, 10, 0, 0)
const secs = (ms) => Math.floor(ms / 1000)

// A Glofox /2.0/events row (fields verified live — see fetchUpcomingEvents).
function gfxClass(over = {}) {
  return {
    _id: 'c1',
    name: 'UN1T Strength',
    time_start: secs(NOW + 4 * 3600), // 14:00, upcoming
    duration: 45,
    size: 16,
    booked: 4,
    waiting: 0,
    active: true,
    private: false,
    ...over,
  }
}

describe('classifyLowFillClasses', () => {
  it('flags an upcoming class under the fill threshold', () => {
    const out = classifyLowFillClasses([gfxClass()], NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'c1', name: 'UN1T Strength', booked: 4, size: 16 })
    expect(out[0].fillPct).toBe(25)
  })

  it('keeps a class at or above the threshold out of the list', () => {
    const at = gfxClass({ booked: Math.ceil(16 * LOW_FILL_THRESHOLD) })
    expect(classifyLowFillClasses([at], NOW)).toHaveLength(0)
  })

  it('ignores classes that already started', () => {
    const past = gfxClass({ time_start: secs(NOW - 3600) })
    expect(classifyLowFillClasses([past], NOW)).toHaveLength(0)
  })

  it('ignores private, inactive, and zero-size rows (no fill math on them)', () => {
    expect(classifyLowFillClasses([
      gfxClass({ private: true }),
      gfxClass({ _id: 'c2', active: false }),
      gfxClass({ _id: 'c3', size: 0 }),
      gfxClass({ _id: 'c4', size: null }),
    ], NOW)).toHaveLength(0)
  })

  it('sorts by start time and survives junk input', () => {
    const later = gfxClass({ _id: 'late', time_start: secs(NOW + 8 * 3600) })
    const sooner = gfxClass({ _id: 'soon', time_start: secs(NOW + 2 * 3600) })
    expect(classifyLowFillClasses([later, null, sooner, 'x'], NOW).map((c) => c.id))
      .toEqual(['soon', 'late'])
    expect(classifyLowFillClasses(null, NOW)).toEqual([])
  })
})

describe('churnSnapshotDelta', () => {
  it('returns the rise/fall vs the previous snapshot', () => {
    expect(churnSnapshotDelta(7, { high_risk: 5, created_at: '2026-06-08T06:00:00Z' }))
      .toEqual({ delta: 2, sinceIso: '2026-06-08T06:00:00Z' })
    expect(churnSnapshotDelta(3, { high_risk: 5, created_at: '2026-06-08T06:00:00Z' }).delta)
      .toBe(-2)
  })

  it('returns null delta when there is no usable snapshot', () => {
    expect(churnSnapshotDelta(7, null)).toEqual({ delta: null, sinceIso: null })
    expect(churnSnapshotDelta(7, { high_risk: undefined, created_at: 'x' }).delta).toBe(null)
  })
})

describe('filterTasksDueToday', () => {
  const t = (over) => ({ id: 'a1', kind: 'task', done: false, due_date: '2026-06-12', subject: 'Call Sarah', ...over })

  it('keeps open tasks due today or overdue, oldest due first', () => {
    const out = filterTasksDueToday([
      t({ id: 'today' }),
      t({ id: 'overdue', due_date: '2026-06-10' }),
      t({ id: 'future', due_date: '2026-06-13' }),
      t({ id: 'done', done: true }),
      t({ id: 'event', kind: 'event' }),
      t({ id: 'undated', due_date: null }),
    ], '2026-06-12')
    expect(out.map((x) => x.id)).toEqual(['overdue', 'today'])
  })

  it('returns [] for junk input', () => {
    expect(filterTasksDueToday(null, '2026-06-12')).toEqual([])
  })
})

describe('assembleTodayFeed', () => {
  // A fully-populated bundle. null = source unavailable (no permission
  // or fetch failed); numbers/arrays = fetched values.
  const full = {
    approvals: 3,
    issues: 2,
    invoices: 1,
    whatsappUnread: 5,
    bookingsToday: { count: 2, nextLabel: '11:30 Consultation' },
    churn: { highRisk: 4, delta: 2, sinceIso: '2026-06-08T06:00:00Z', topMembers: ['Mark D', 'Aoife L', 'Tom K', 'Extra P'] },
    tasksDue: [{ subject: 'Call Sarah', due_date: '2026-06-10' }],
    lowFill: [{ id: 'c1', name: 'UN1T Strength', timeLabel: '18:00', fillPct: 25, booked: 4, size: 16 }],
  }

  it('emits the rows in triage order with hrefs', () => {
    const rows = assembleTodayFeed(full)
    expect(rows.map((r) => r.id)).toEqual(
      ['approvals', 'issues', 'invoices', 'whatsapp', 'bookings', 'churn', 'tasks', 'lowfill'])
    const hrefs = Object.fromEntries(rows.map((r) => [r.id, r.href]))
    expect(hrefs.approvals).toBe('/approvals')
    expect(hrefs.whatsapp).toBe('/communications/inbox')
    expect(hrefs.churn).toBe('/dashboard/churn-radar')
    expect(hrefs.tasks).toBe('/activities')
  })

  it('omits sources that are null (no permission / fetch failed)', () => {
    const rows = assembleTodayFeed({ ...full, approvals: null, lowFill: null })
    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain('approvals')
    expect(ids).not.toContain('lowfill')
  })

  it('omits rows with nothing to act on (count 0 / empty lists)', () => {
    const rows = assembleTodayFeed({
      approvals: 0, issues: 0, invoices: 0, whatsappUnread: 0,
      bookingsToday: { count: 0, nextLabel: null },
      churn: { highRisk: 0, delta: null, sinceIso: null, topMembers: [] },
      tasksDue: [], lowFill: [],
    })
    expect(rows).toEqual([])
  })

  it('caps row items at three and carries counts', () => {
    const churnRow = assembleTodayFeed(full).find((r) => r.id === 'churn')
    expect(churnRow.count).toBe(4)
    expect(churnRow.items.length).toBeLessThanOrEqual(3)
    expect(churnRow.detail).toContain('2') // the rise vs last snapshot
  })
})
