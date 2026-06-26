// POST /api/admin/achievements/test
//
// Read-only preview of what achievements a given contact would
// unlock, given their current session history. NEVER inserts —
// useful for "would the new 'streak_5' rule unlock for Sarah?"
// without committing.
//
// Body: { contact_id: uuid, rule_id?: uuid }
//   rule_id present  → run only that rule (used in the rule editor)
//   rule_id absent   → run every active rule and return the full set

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { buildAchievementContext, runDetectors } from '@/lib/achievements'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HISTORY_LOOKBACK_DAYS = 365

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function POST(request) {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  let body
  try { body = await request.json() }
  catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }) }

  const contactId = String(body?.contact_id || '').trim()
  if (!contactId) return NextResponse.json({ ok: false, error: 'contact_id required' }, { status: 400 })
  const ruleId = body?.rule_id ? String(body.rule_id) : null

  const db = createServerClient()

  // Load contact's sessions.
  // AUDIT P1-2 — paginated (mirrors achievements.js runDetectionForSession):
  // the same 365-day history fetch, which can exceed the 1000-row cap for a
  // frequent member and silently truncate the preview. selectAll throws on a
  // DB error; map it back to the existing 500-with-message path.
  const since = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  let sessions
  try {
    sessions = await selectAll((from, to) => db
      .from('heart_rate_sessions')
      .select('id, contact_id, location_id, booking_id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, max_hr_used, bookings:bookings(event_type_id)')
      .eq('contact_id', contactId)
      .not('ended_at', 'is', null)
      .gte('started_at', since)
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ ok: true, fired: [], reason: 'no sessions in window' })
  }

  for (const s of sessions) s.event_type_id = s.bookings?.event_type_id || null
  const latest = sessions[sessions.length - 1]
  const history = sessions.slice(0, -1)
  const ctx = buildAchievementContext(latest, history)

  // Load rules to test (one or all active).
  let rulesQuery = db.from('achievement_rules').select('id, slug, name, rule_type, rule_config, is_active')
  if (ruleId) rulesQuery = rulesQuery.eq('id', ruleId)
  else rulesQuery = rulesQuery.eq('is_active', true)
  const { data: rules } = await rulesQuery

  // Already-earned: report so the UI can grey them out.
  const { data: earned } = await db
    .from('contact_achievements')
    .select('rule_id, earned_at')
    .eq('contact_id', contactId)
  const earnedMap = new Map((earned || []).map((r) => [r.rule_id, r.earned_at]))

  const fired = runDetectors(rules || [], ctx)
  const result = fired.map(({ rule, metadata }) => ({
    rule_id: rule.id,
    slug: rule.slug,
    name: rule.name,
    metadata,
    already_earned_at: earnedMap.get(rule.id) || null,
  }))

  return NextResponse.json({
    ok: true,
    contact_id: contactId,
    sessions_in_window: sessions.length,
    fired: result,
  })
}
