// Canonical, versioned post-class "Session Report" — the single
// surface-agnostic payload rendered by the champ-app session view,
// the champ-app report API (future native app + cards), and the
// un1t-crm post-class email.
//
// Pure: no IO, no Date.now() unless nowMs is passed. It ASSEMBLES the
// existing HR helpers (it re-implements none of the maths) and adds
// the version envelope + the null slots for later slices.
//
// KEEP IN SYNC across champ-app + un1t-crm (champ-app is canon).
//
// Each copy asserts against the fixture NEXT TO IT — shared/__fixtures__/ and
// src/lib/__fixtures__/session-report.fixture.json. This comment used to name
// only the src/lib path in both copies, which is wrong for the shared one and
// reads as "there is a single fixture". There are two files; they are
// byte-identical, and tests/shared-pair-sync.test.js now asserts that. If they
// ever diverge, both suites keep passing against different inputs.

import { zoneBreakdown, burnSeconds, isBurn } from './heart-rate.js'
import { buildSessionAnalytics } from './hr-analytics.js'

export const SESSION_REPORT_VERSION = 1

export const DEFAULT_JOIN_CTA = 'Become a member'
// FUNNEL.1 (un1t-crm PR #762) — pipeline taxonomy is now the acquisition
// funnel; members are 'converted' (joined ≤60d ago) or 'member'. The old
// active_member/at_risk_member slugs stop existing after the CRM-side
// reclassify cutover.
const MEMBER_STAGES = ['converted', 'member']

/**
 * Context-aware post-class CTA. Pulse stays OUT of booking (the Glofox member
 * app owns booking/pause/cancel — product boundary), so active members get NO
 * next-action from the post-class report. Non-members still get a join CTA
 * (a conversion action, not a booking action). Label is operator-editable
 * (cta.membershipLabel); DEFAULT_JOIN_CTA is a placeholder fallback only.
 * Returns null when there is no eligible action / URL (no broken/empty button).
 * Pure.
 */
export function buildNextAction(cta) {
  if (!cta) return null
  if (MEMBER_STAGES.includes(cta.stage)) return null
  if (!cta.membershipSignupUrl) return null
  return { type: 'join', label: cta.membershipLabel || DEFAULT_JOIN_CTA, url: cta.membershipSignupUrl }
}

function durationSeconds(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null
}

function mapTrend(trend, field) {
  if (!trend) {
    return { field, direction: 'flat', delta_pct: null, recent_mean: null, prior_mean: null, has_enough_data: false }
  }
  return {
    field,
    direction: trend.direction || 'flat',
    delta_pct: Number.isFinite(trend.deltaPct) ? trend.deltaPct : null,
    recent_mean: Number.isFinite(trend.recentMean) ? Math.round(trend.recentMean) : null,
    prior_mean: Number.isFinite(trend.priorMean) ? Math.round(trend.priorMean) : null,
    has_enough_data: Boolean(trend.hasEnoughData),
  }
}

function mapAchievements(achievements) {
  return (achievements || [])
    .map((a) => ({
      slug: a.slug ?? a.rule?.slug ?? null,
      name: a.name ?? a.rule?.name ?? null,
      icon: a.icon ?? a.rule?.icon ?? null,
      earned_at: a.earned_at ?? null,
    }))
    .filter((a) => a.slug && a.name)
}

/**
 * @param {object} ctx
 *   session       heart_rate_sessions row (zones_seconds, effort_points, avg/peak/max, started/ended, source)
 *   thisSession   analytics shape (see hr-analytics.js) — includes event_type_id
 *   history       array of analytics-shape rows (90-day window)
 *   eventTypeName string | null
 *   achievements? rows ({slug,name,icon,earned_at} or {rule:{...},earned_at})
 * @param {{nowMs?: number}} opts
 */
export function buildSessionReport(ctx, { nowMs = Date.now() } = {}) {
  const { session, thisSession, history, eventTypeName } = ctx
  const analytics = buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs })
  const ct = analytics.classType || {}
  const zones = zoneBreakdown(session.zones_seconds).map((z) => ({
    id: z.id, name: z.name, color: z.color, seconds: z.seconds, percent: z.percent,
  }))

  return {
    version: SESSION_REPORT_VERSION,
    session: {
      id: session.id,
      started_at: session.started_at || null,
      ended_at: session.ended_at || null,
      duration_seconds: durationSeconds(session.started_at, session.ended_at),
      source: session.source || null,
      class: {
        event_type_id: thisSession?.event_type_id ?? null,
        name: eventTypeName || null,
        category: thisSession?.category ?? null,
      },
    },
    summary: {
      effort_points: Number.isFinite(session.effort_points) ? session.effort_points : 0,
      avg_hr_bpm: Number.isFinite(session.avg_hr_bpm) ? session.avg_hr_bpm : null,
      peak_hr_bpm: Number.isFinite(session.peak_hr_bpm) ? session.peak_hr_bpm : null,
      max_hr_used: Number.isFinite(session.max_hr_used) ? session.max_hr_used : null,
      zones,
      // The Burn — binary Z4+ win condition (≥12 min in Zone 4/5). Shipped
      // as a boolean + the Zone 4+ minutes so every surface renders it the
      // same way without re-doing the maths.
      burn: isBurn(session.zones_seconds),
      z4plus_minutes: Math.round(burnSeconds(session.zones_seconds) / 60),
    },
    comparisons: {
      vs_recent: mapTrend(analytics.overall?.pointsTrend, 'effort_points'),
      vs_recent_peak: mapTrend(analytics.overall?.peakTrend, 'peak_hr_bpm'),
      vs_this_class: {
        event_type_name: ct.eventTypeName ?? eventTypeName ?? null,
        mean_points: Number.isFinite(ct.meanPoints) ? ct.meanPoints : null,
        percentile: Number.isFinite(ct.percentile) ? ct.percentile : null,
        sample_size: Number.isFinite(ct.recentCount) ? ct.recentCount : 0,
      },
      vs_category: analytics.category ? {
        category: analytics.category.categoryName,
        mean_points: Number.isFinite(analytics.category.meanPoints) ? analytics.category.meanPoints : null,
        percentile: Number.isFinite(analytics.category.percentile) ? analytics.category.percentile : null,
        sample_size: Number.isFinite(analytics.category.recentCount) ? analytics.category.recentCount : 0,
      } : null,
    },
    highlight: analytics.highlight || null,
    achievements: mapAchievements(ctx.achievements),
    next_action: buildNextAction(ctx.cta),
  }
}
