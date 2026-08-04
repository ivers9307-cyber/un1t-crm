import { describe, it, expect } from 'vitest'
import { buildSessionPush, buildGoalPush, buildStreakAtRiskPush, buildTargetHitPush, buildTierUpPush, buildFriendRequestPush, buildFriendAcceptedPush, buildReactionPush, periodKey, streakAtRisk } from './customer-notifications.js'
import { attendanceDrop, buildWinbackPush, buildClassReminderPush } from './customer-notifications.js'

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

describe('buildStreakAtRiskPush', () => {
  it('names the streak length', () => {
    const r = buildStreakAtRiskPush({ streak: 5 })
    expect(r.title).toBe('Keep the 5-day streak alive')
    expect(r.body).toBe("Train today so you don't lose it.")
    expect(r.data).toEqual({ type: 'streak_at_risk' })
  })
})

describe('periodKey', () => {
  it('month key', () => {
    expect(periodKey('month', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-06')
  })
  it('ISO week key', () => {
    expect(periodKey('week', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-W25')
  })
})

describe('streakAtRisk', () => {
  const N = new Date('2026-06-20T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()
  it('flags a >=3 run ending yesterday with nothing today', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }, { started_at: dayAgo(3) }]
    expect(streakAtRisk(ss, N, 3)).toBe(3)
  })
  it('does not flag if they already trained today', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a run below the threshold', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a streak already broken (last session 2 days ago)', () => {
    const ss = [{ started_at: dayAgo(2) }, { started_at: dayAgo(3) }, { started_at: dayAgo(4) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })

  it('flags at the Dublin midnight edge (23:30Z BST = 00:30 next Dublin day)', () => {
    // 2026-06-20T23:30Z is already 00:30 on 06-21 in Dublin (IST). A member
    // whose run ended on the 06-20 Dublin day is at risk NOW — a UTC "today"
    // comparison (still 06-20 in UTC) misses this whole 23:00-24:00Z window.
    const edge = new Date('2026-06-20T23:30:00Z').getTime()
    const ss = [
      { started_at: '2026-06-20T10:00:00Z' },
      { started_at: '2026-06-19T10:00:00Z' },
      { started_at: '2026-06-18T10:00:00Z' },
    ]
    expect(streakAtRisk(ss, edge, 3)).toBe(3)
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
const _DAY = 24*3600*1000
const _now = Date.parse('2026-06-21T12:00:00Z')
const _sAt = (daysAgo) => ({ started_at: new Date(_now - daysAgo*_DAY).toISOString() })

describe('attendanceDrop', () => {
  it('fires when a regular halves their rate but is still current', () => {
    const base = []; for (let d = 15; d <= 83; d += 3.5) base.push(_sAt(d))
    expect(attendanceDrop([...base, _sAt(10)], _now).dropping).toBe(true)
  })
  it('does NOT fire when attendance is steady', () => {
    const all = []; for (let d = 1; d <= 83; d += 3.5) all.push(_sAt(d))
    expect(attendanceDrop(all, _now).dropping).toBe(false)
  })
  it('does NOT fire for a non-regular (baseline below threshold)', () => {
    expect(attendanceDrop([_sAt(20), _sAt(40), _sAt(10)], _now).dropping).toBe(false)
  })
  it('does NOT fire when long-gone (last session beyond stillCurrentDays)', () => {
    // strong baseline, but the most recent session is 50d ago (> 42) → not current
    const base = []; for (let d = 50; d <= 110; d += 3) base.push(_sAt(d))
    expect(attendanceDrop(base, _now).dropping).toBe(false)
  })
  it('FIRES for a regular who went fully quiet recently but is still current (core win-back case)', () => {
    // trained ~2x/wk through ~3 weeks ago, nothing in the last 14d, last session 18d ago (< 42)
    const base = []; for (let d = 18; d <= 83; d += 3.5) base.push(_sAt(d))
    expect(attendanceDrop(base, _now).dropping).toBe(true)
  })
  it('empty + future-dated sessions are safe', () => {
    expect(attendanceDrop([], _now).dropping).toBe(false)
    expect(attendanceDrop([{ started_at: new Date(_now + _DAY).toISOString() }], _now).dropping).toBe(false)
  })
})
describe('buildWinbackPush', () => {
  it('returns the winback push shape', () => {
    const p = buildWinbackPush()
    expect(p.data.type).toBe('winback'); expect(p.title).toBeTruthy(); expect(p.body).toBeTruthy()
  })
})
