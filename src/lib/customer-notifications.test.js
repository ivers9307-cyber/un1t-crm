// Tests for customer-notifications.js — every push builder, the push
// idempotency periodKey (Dublin-calendar + year-boundary correctness),
// the streakAtRisk predicate (Dublin/UTC midnight + DST edges), and
// attendanceDrop. BYTE-SYNC: this file is fully identical in
// champ-app/shared/ and un1t-crm/src/lib/ (the relative import works in
// both) — port new tests both ways.

import { describe, it, expect } from 'vitest'
import {
  buildSessionPush,
  buildGoalPush,
  buildTargetHitPush,
  buildTierUpPush,
  buildStreakAtRiskPush,
  buildClassReminderPush,
  buildFriendRequestPush,
  buildFriendAcceptedPush,
  buildReactionPush,
  buildWinbackPush,
  periodKey,
  streakAtRisk,
  attendanceDrop,
} from './customer-notifications.js'

const DAY = 24 * 3600 * 1000
const at = (iso) => new Date(iso).getTime()

// ── buildSessionPush ──────────────────────────────────────────────

describe('buildSessionPush', () => {
  const base = { effortPoints: 280, className: 'Conditioning', sessionId: 'sess-1' }
  it('no achievement → session-ready copy', () => {
    expect(buildSessionPush({ ...base, unlocked: [] })).toEqual({
      title: 'Your session is ready',
      body: '280 UN1T Points · Conditioning',
      data: { type: 'session_report', session_id: 'sess-1' },
    })
  })
  it('one achievement → leads with the name', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'First Z5' }] })
    expect(r.title).toBe('New achievement — First Z5')
    expect(r.body).toBe('280 UN1T Points · Conditioning. Tap to see your stats.')
    expect(r.data).toEqual({ type: 'achievement', session_id: 'sess-1', count: 1 })
  })
  it('two+ achievements → counts them', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'A' }, { name: 'B' }] })
    expect(r.title).toBe('You unlocked 2 achievements')
    expect(r.data.count).toBe(2)
  })
  it('missing points → fallback phrase, missing class → no suffix', () => {
    const r = buildSessionPush({ effortPoints: null, className: null, sessionId: 's', unlocked: [] })
    expect(r.body).toBe('Tap to see your stats')
  })
})

// ── remaining push builders ───────────────────────────────────────

describe('buildGoalPush', () => {
  it('weekly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g1', target_value: 500 }, def: { unit: 'points', period: 'week' } })
    expect(r.title).toBe('Goal smashed — 500 points this week')
    expect(r.body).toBe('Weekly target complete. Nice work.')
    expect(r.data).toEqual({ type: 'goal', goal_id: 'g1' })
  })
  it('monthly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g2', target_value: 16 }, def: { unit: 'classes', period: 'month' } })
    expect(r.title).toBe('Goal smashed — 16 classes this month')
    expect(r.body).toBe('Monthly target complete. Nice work.')
  })
})

describe('buildTargetHitPush', () => {
  it('names the month + months-to-next', () => {
    const r = buildTargetHitPush({ monthLabel: 'June', monthsHit: 5, next: { name: 'Gold', months: 6 } })
    expect(r.title).toBe('June target hit 🎯')
    expect(r.body).toBe('Month 5 banked — 1 to Gold.')
    expect(r.data).toEqual({ type: 'monthly_target_hit' })
  })
  it('handles the top of the ladder (no next tier)', () => {
    const r = buildTargetHitPush({ monthLabel: 'June', monthsHit: 30, next: null })
    expect(r.body).toBe('Month 30 banked — your best run yet.')
  })
})

describe('buildTierUpPush', () => {
  it('announces the new tier', () => {
    const r = buildTierUpPush({ tier: { name: 'Gold' }, monthsHit: 6 })
    expect(r.title).toBe('You reached Gold 🏆')
    expect(r.body).toBe('6 months hit. Keep the run going.')
    expect(r.data).toEqual({ type: 'tier_up' })
  })
})

describe('buildStreakAtRiskPush', () => {
  it('names the streak length', () => {
    const r = buildStreakAtRiskPush({ streak: 5 })
    expect(r.title).toBe('Keep the 5-day streak alive')
    expect(r.body).toBe("Train today so you don't lose it.")
    expect(r.data).toEqual({ type: 'streak_at_risk' })
  })
})

describe('buildClassReminderPush', () => {
  it('builds a pre-class reminder with the class name + time label', () => {
    const p = buildClassReminderPush({ className: 'UN1T HIIT', timeLabel: '7:30pm', classBookingId: 'cb-1' })
    expect(p.title).toBe('UN1T HIIT starting soon')
    expect(p.body).toContain('7:30pm')
    expect(p.data).toEqual({ type: 'class_reminder', class_booking_id: 'cb-1' })
  })
  it('degrades gracefully with no name / time', () => {
    const p = buildClassReminderPush({})
    expect(p.title).toBe('Your class starting soon')
    expect(p.data.type).toBe('class_reminder')
    expect(p.data.class_booking_id).toBeNull()
  })
})

describe('buildFriendRequestPush', () => {
  it('names the requester and sets friend_request type', () => {
    const r = buildFriendRequestPush({ fromName: 'Alex' })
    expect(r.title).toBe('New friend request')
    expect(r.body).toBe('Alex wants to be friends')
    expect(r.data).toEqual({ type: 'friend_request' })
  })
})

describe('buildFriendAcceptedPush', () => {
  it('names the accepter and sets friend_request type', () => {
    const r = buildFriendAcceptedPush({ name: 'Jordan' })
    expect(r.title).toBe('Friend request accepted')
    expect(r.body).toBe('Jordan accepted your request')
    expect(r.data).toEqual({ type: 'friend_request' })
  })
})

describe('buildReactionPush', () => {
  it('formats from name + emoji + context and sets feed type', () => {
    const r = buildReactionPush({ fromName: 'Sam', reactionEmoji: '💪', context: 'session' })
    expect(r.title).toBe('Sam reacted 💪')
    expect(r.body).toBe('to your session')
    expect(r.data).toEqual({ type: 'feed' })
  })
  it('works with achievement context', () => {
    const r = buildReactionPush({ fromName: 'Lee', reactionEmoji: '🔥', context: 'achievement' })
    expect(r.title).toBe('Lee reacted 🔥')
    expect(r.body).toBe('to your achievement')
    expect(r.data).toEqual({ type: 'feed' })
  })
})

describe('buildWinbackPush', () => {
  it('returns the winback push shape', () => {
    const p = buildWinbackPush()
    expect(p.data.type).toBe('winback')
    expect(p.title).toBeTruthy()
    expect(p.body).toBeTruthy()
  })
})

// ── periodKey ─────────────────────────────────────────────────────

describe('periodKey — month', () => {
  it('formats YYYY-MM on the Dublin calendar', () => {
    expect(periodKey('month', at('2026-06-15T12:00:00Z'))).toBe('2026-06')
  })
  it('IST midnight-edge belongs to the Dublin month', () => {
    // 00:30 IST on 1 Jul (= 2026-06-30T23:30Z) is July, not June.
    expect(periodKey('month', at('2026-06-30T23:30:00Z'))).toBe('2026-07')
  })
})

describe('periodKey — ISO week', () => {
  it('formats YYYY-Www', () => {
    expect(periodKey('week', at('2026-06-20T12:00:00Z'))).toBe('2026-W25')
  })
  it('IST midnight-edge belongs to the Dublin day\'s ISO week', () => {
    // Sun 2026-06-21T23:30Z is already Mon 22 Jun 00:30 IST → next ISO week.
    expect(periodKey('week', at('2026-06-21T23:30:00Z'))).toBe('2026-W26')
  })
  it('2025-W01 and 2026-W01 are distinct keys across the year roll', () => {
    // Wed 2025-01-01 is ISO 2025-W01; Wed 2026-01-01 is ISO 2026-W01.
    const k2025 = periodKey('week', at('2025-01-01T12:00:00Z'))
    const k2026 = periodKey('week', at('2026-01-01T12:00:00Z'))
    expect(k2025).toBe('2025-W01')
    expect(k2026).toBe('2026-W01')
    expect(k2025).not.toBe(k2026)
  })
  it('late-December Monday already belongs to the NEXT ISO week-year', () => {
    // Mon 2025-12-29 is ISO week 2026-W01 (week-year != calendar year).
    expect(periodKey('week', at('2025-12-29T12:00:00Z'))).toBe('2026-W01')
  })
  it('Tue 2024-12-31 belongs to ISO 2025-W01', () => {
    expect(periodKey('week', at('2024-12-31T12:00:00Z'))).toBe('2025-W01')
  })
})

// ── streakAtRisk ──────────────────────────────────────────────────

describe('streakAtRisk', () => {
  // "now" mid-afternoon so today/yesterday are unambiguous.
  const now = at('2026-06-23T15:00:00Z')

  it('returns the streak when the run ended YESTERDAY (Dublin) and >= minStreak', () => {
    const sessions = [
      { started_at: '2026-06-22T10:00:00Z' }, // yesterday
      { started_at: '2026-06-21T10:00:00Z' },
      { started_at: '2026-06-20T10:00:00Z' },
    ]
    expect(streakAtRisk(sessions, now, 3)).toBe(3)
  })

  it('returns 0 when the member already trained TODAY (not at risk)', () => {
    const sessions = [
      { started_at: '2026-06-23T09:00:00Z' }, // today
      { started_at: '2026-06-22T10:00:00Z' },
      { started_at: '2026-06-21T10:00:00Z' },
    ]
    expect(streakAtRisk(sessions, now, 3)).toBe(0)
  })

  it('returns 0 when the last session is 2+ days ago', () => {
    const sessions = [
      { started_at: '2026-06-21T10:00:00Z' }, // 2 days ago
      { started_at: '2026-06-20T10:00:00Z' },
      { started_at: '2026-06-19T10:00:00Z' },
    ]
    expect(streakAtRisk(sessions, now, 3)).toBe(0)
  })

  it('returns 0 when the run is shorter than minStreak', () => {
    const sessions = [
      { started_at: '2026-06-22T10:00:00Z' }, // yesterday only
    ]
    expect(streakAtRisk(sessions, now, 3)).toBe(0)
  })

  it('Dublin/UTC midnight edge: an IST 23:xx-UTC session yesterday counts', () => {
    // "now" = 2026-06-23T15:00Z. A session at 2026-06-21T23:30Z is
    // 00:30 IST on 2026-06-22 in Dublin = YESTERDAY, so a 3-run ending
    // there is at risk. A naive UTC "yesterday = now - 24h" (=Jun 22
    // 15:00) with UTC bucketing would place this session on Jun 21 and
    // MISS it.
    const sessions = [
      { started_at: '2026-06-21T23:30:00Z' }, // Dublin Jun 22 (yesterday)
      { started_at: '2026-06-20T23:30:00Z' }, // Dublin Jun 21
      { started_at: '2026-06-19T23:30:00Z' }, // Dublin Jun 20
    ]
    expect(streakAtRisk(sessions, now, 3)).toBe(3)
  })

  it('flags at the Dublin midnight edge (23:30Z BST = 00:30 next Dublin day)', () => {
    // 2026-06-20T23:30Z is already 00:30 on 06-21 in Dublin (IST). A member
    // whose run ended on the 06-20 Dublin day is at risk NOW — a UTC "today"
    // comparison (still 06-20 in UTC) misses this whole 23:00-24:00Z window.
    const edge = at('2026-06-20T23:30:00Z')
    const sessions = [
      { started_at: '2026-06-20T10:00:00Z' },
      { started_at: '2026-06-19T10:00:00Z' },
      { started_at: '2026-06-18T10:00:00Z' },
    ]
    expect(streakAtRisk(sessions, edge, 3)).toBe(3)
  })

  it('spring-forward night: streak ending on the DST Sunday is detected next day', () => {
    // now = Mon 2026-03-30 15:00 IST. Yesterday = Sun 2026-03-29 (spring-fwd).
    const nowDst = at('2026-03-30T14:00:00Z') // 15:00 IST
    const sessions = [
      { started_at: '2026-03-29T10:00:00Z' }, // Sun 29 Dublin (yesterday)
      { started_at: '2026-03-28T10:00:00Z' }, // Sat 28
      { started_at: '2026-03-27T10:00:00Z' }, // Fri 27
    ]
    expect(streakAtRisk(sessions, nowDst, 3)).toBe(3)
  })
})

// ── attendanceDrop ────────────────────────────────────────────────

describe('attendanceDrop', () => {
  const now = at('2026-06-30T12:00:00Z')
  const sAt = (daysAgo) => ({ started_at: new Date(now - daysAgo * DAY).toISOString() })

  it('fires when a regular halves their rate but is still current', () => {
    const sessions = []
    for (let d = 15; d <= 83; d += 3.5) sessions.push(sAt(d))
    expect(attendanceDrop([...sessions, sAt(10)], now).dropping).toBe(true)
  })

  it('FIRES for a regular who fully stopped recently but is still current (core win-back case)', () => {
    // Baseline: ~2/week over the 70-day baseline window (before the last
    // 14 days); recent 14 days: nothing, but last session within 42 days.
    const sessions = []
    for (let d = 15; d <= 69; d += 3) sessions.push(sAt(d))
    const r = attendanceDrop(sessions, now)
    expect(r.dropping).toBe(true)
    expect(r.recentRate).toBe(0)
    expect(r.baselineRate).toBeGreaterThanOrEqual(1)
  })

  it('does NOT flag a steady attendee', () => {
    const sessions = []
    for (let d = 1; d <= 80; d += 3) sessions.push(sAt(d))
    expect(attendanceDrop(sessions, now).dropping).toBe(false)
  })

  it('does NOT flag a non-regular (baseline below threshold)', () => {
    expect(attendanceDrop([sAt(20), sAt(40), sAt(10)], now).dropping).toBe(false)
  })

  it('does NOT flag a long-gone member (last session outside stillCurrentDays)', () => {
    const sessions = []
    for (let d = 50; d <= 80; d += 3) sessions.push(sAt(d))
    // last session ~50 days ago > default stillCurrentDays (42) → not a win-back.
    expect(attendanceDrop(sessions, now).dropping).toBe(false)
  })

  it('ignores empty, future-dated and unparseable sessions', () => {
    expect(attendanceDrop([], now).dropping).toBe(false)
    const sessions = [
      { started_at: new Date(now + 5 * DAY).toISOString() }, // future
      { started_at: 'not-a-date' },
    ]
    const r = attendanceDrop(sessions, now)
    expect(r.dropping).toBe(false)
    expect(r.baselineRate).toBe(0)
    expect(r.recentRate).toBe(0)
  })
})
