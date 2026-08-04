// Pure builders for the customer engagement-loop notifications + the
// streak-at-risk predicate. No IO — callers (endSession, the cron) load
// data and call sendCustomerPush. Kept pure so the copy + logic are
// fixture-testable.

import { currentStreak } from '@/lib/hr-analytics'
import { dublinDateKey, dublinDayStartMs } from '@/lib/dublin-time'

function pointsPhrase(effortPoints) {
  return Number.isFinite(effortPoints) ? `${effortPoints} UN1T Points` : 'Tap to see your stats'
}

/** One consolidated session-end push. Leads with the achievement if any unlocked. */
export function buildSessionPush({ effortPoints, className, sessionId, unlocked }) {
  const pts = pointsPhrase(effortPoints)
  const cls = className ? ` · ${className}` : ''
  const n = (unlocked || []).length
  if (n === 1) {
    return {
      title: `New achievement — ${unlocked[0].name}`,
      body: `${pts}${cls}. Tap to see your stats.`,
      data: { type: 'achievement', session_id: sessionId, count: 1 },
    }
  }
  if (n >= 2) {
    return {
      title: `You unlocked ${n} achievements`,
      body: `${pts}${cls}. Tap to see your stats.`,
      data: { type: 'achievement', session_id: sessionId, count: n },
    }
  }
  return {
    title: 'Your session is ready',
    body: `${pts}${cls}`,
    data: { type: 'session_report', session_id: sessionId },
  }
}

/** Goal-completion push. `def` is the GOAL_DEFS entry (has unit + period). */
export function buildGoalPush({ goal, def }) {
  const word = def.period === 'month' ? 'this month' : 'this week'
  const cap = def.period === 'month' ? 'Monthly' : 'Weekly'
  return {
    title: `Goal smashed — ${goal.target_value} ${def.unit} ${word}`,
    body: `${cap} target complete. Nice work.`,
    data: { type: 'goal', goal_id: goal.id },
  }
}

/** Monthly-target-hit push (no tier change this bank). `next` is the next tier or null. */
export function buildTargetHitPush({ monthLabel, monthsHit, next }) {
  const tail = next
    ? `Month ${monthsHit} banked — ${next.months - monthsHit} to ${next.name}.`
    : `Month ${monthsHit} banked — your best run yet.`
  return { title: `${monthLabel} target hit 🎯`, body: tail, data: { type: 'monthly_target_hit' } }
}

/** Tier-up push — this bank advanced the belt. */
export function buildTierUpPush({ tier, monthsHit }) {
  return {
    title: `You reached ${tier.name} 🏆`,
    body: `${monthsHit} months hit. Keep the run going.`,
    data: { type: 'tier_up' },
  }
}

/** Streak-at-risk nudge push. */
export function buildStreakAtRiskPush({ streak }) {
  return {
    title: `Keep the ${streak}-day streak alive`,
    body: "Train today so you don't lose it.",
    data: { type: 'streak_at_risk' },
  }
}

/** Pre-class reminder push (P2-7) — a member with a booked class coming up. */
export function buildClassReminderPush({ className, timeLabel, classBookingId } = {}) {
  const name = className ? String(className) : 'Your class'
  const when = timeLabel ? ` at ${timeLabel}` : ''
  return {
    title: `${name} starting soon`,
    body: `You're booked in${when} — see you there 💪`,
    data: { type: 'class_reminder', class_booking_id: classBookingId || null },
  }
}

/** Idempotency key for a goal/period: YYYY-MM (month) or YYYY-Www (ISO week). */
export function periodKey(period, nowMs = Date.now()) {
  const d = new Date(nowMs)
  if (period === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ftDayNum) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function buildFriendRequestPush({ fromName }) {
  return { title: 'New friend request', body: `${fromName} wants to be friends`, data: { type: 'friend_request' } }
}
export function buildFriendAcceptedPush({ name }) {
  return { title: 'Friend request accepted', body: `${name} accepted your request`, data: { type: 'friend_request' } }
}
export function buildReactionPush({ fromName, reactionEmoji, context }) {
  return { title: `${fromName} reacted ${reactionEmoji}`, body: `to your ${context}`, data: { type: 'feed' } }
}

/**
 * Streak-at-risk: returns the streak length if the member trained YESTERDAY
 * (not today) and the run ending yesterday is >= minStreak; else 0.
 */
export function streakAtRisk(sessions, nowMs = Date.now(), minStreak = 3) {
  // currentStreak returns lastDayMs as the Dublin-midnight instant of the
  // most recent training day. "Yesterday" must be the Dublin-midnight of
  // the previous Dublin calendar day (not nowMs - 24h), so this stays
  // correct across an IST/GMT DST-transition night.
  const yesterdayKey = dublinDateKey(dublinDayStartMs(dublinDateKey(nowMs)) - 12 * 3600 * 1000)
  const yesterdayMs = dublinDayStartMs(yesterdayKey)
  const st = currentStreak(sessions, nowMs)
  if (st.lastDayMs === yesterdayMs && st.current >= minStreak) return st.current
  return 0
}

// Personalized HR-attendance drop detector for win-back nudges.
// baseline window [now-baselineDays, now-recentDays); recent window [now-recentDays, now).
export function attendanceDrop(sessions, nowMs = Date.now(), {
  baselineDays = 84, recentDays = 14, minBaselinePerWeek = 1.0,
  dropFraction = 0.5, stillCurrentDays = 42,
} = {}) {
  const DAY = 24 * 3600 * 1000
  const recentStart = nowMs - recentDays * DAY
  const baselineStart = nowMs - baselineDays * DAY
  let recentCount = 0, baselineCount = 0, lastMs = 0
  for (const s of sessions || []) {
    const t = Date.parse(s?.started_at)
    if (!Number.isFinite(t) || t >= nowMs) continue
    if (t > lastMs) lastMs = t
    if (t >= recentStart) recentCount++
    else if (t >= baselineStart) baselineCount++
  }
  const baselineRate = baselineCount / ((baselineDays - recentDays) / 7)
  const recentRate = recentCount / (recentDays / 7)
  // A regular who fully stopped in the recent window (recentRate === 0) is the
  // PRIMARY win-back case — do NOT exclude them. `stillCurrentDays` (last
  // session within the window) is what separates a recent slowdown from a
  // long-gone member; recentRate === 0 + still-current = exactly who to nudge.
  const dropping =
    baselineRate >= minBaselinePerWeek &&
    recentRate <= dropFraction * baselineRate &&
    lastMs >= nowMs - stillCurrentDays * DAY
  return {
    dropping,
    baselineRate: Math.round(baselineRate * 100) / 100,
    recentRate: Math.round(recentRate * 100) / 100,
  }
}

export function buildWinbackPush() {
  return { title: "We've missed you 👋", body: 'Fancy getting back in this week?', data: { type: 'winback' } }
}
