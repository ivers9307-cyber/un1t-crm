// SONOSLIVE.6 — "run now" applies the active window immediately.
//
// It used to set last_applied = null and let the next cron tick re-fire.
// That was wrong twice over. It was not immediate (up to 60s), and
// last_applied is also the CLOSE's precondition: planAction will only close
// a window it has a record of opening, deliberately, so that recovery after
// downtime cannot silence music a human started by hand. Clearing that
// record meant that if the window ended before a re-open landed, the close
// never fired at all.
//
// Observed live 2026-08-21: window opened 20:55:31, run-now at 20:56:08
// cleared the record, the window's off was edited to an already-past time,
// and nothing wrote to the row for over 90 minutes while the music kept
// playing.
//
// Now it applies the window through applyOpen (src/lib/sonos/apply.js) —
// the SAME function the reconcile cron calls — and so stamps last_applied as
// an open exactly as a cron-driven open would. No wait, and the close's
// precondition is written rather than destroyed. SONOSAPPLY.3 collapsed the
// two copies of that sequence into one; this file no longer carries its own.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { getSonosConfig, withFreshToken, sonosGetGroups } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds, planAction } from '@/lib/sonos/groups'
import { applyOpen } from '@/lib/sonos/apply'
import { dublinDayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const { id } = await params
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) {
    return NextResponse.json({ success: false, error: 'Sonos is not configured' }, { status: 503 })
  }

  const db = createServerClient()
  const { data: schedule, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('id', id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!schedule) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // planAction returns null for BOTH a disabled schedule and a schedule
  // with no active window right now — collapsing them into one message
  // points an operator debugging "run now does nothing" at the wrong fix.
  // A disabled schedule needs "turn it on"; a window gap needs "check your
  // window times". Check enabled first, before planAction ever runs, so
  // the two stay distinguishable.
  if (!schedule.enabled) {
    return NextResponse.json({ success: false, error: 'This schedule is switched off — turn it on first' }, { status: 409 })
  }

  const nowMs = Date.now()
  // planAction is asked what should happen with last_applied ignored, which
  // is exactly what "run it now" means: re-apply the active window whether
  // or not it has already been applied.
  const plan = planAction({ ...schedule, last_applied: null }, nowMs, dublinDayStr(nowMs))
  if (!plan || plan.action !== 'open') {
    // Outside every window there is nothing to apply. Say so — the old
    // route returned success here and looked like it had worked.
    return NextResponse.json({ success: false, error: 'No window is active right now' }, { status: 409 })
  }

  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) {
    return NextResponse.json({ success: false, error: 'Sonos is not connected', reason: tok.reason }, { status: 409 })
  }
  const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) {
    return NextResponse.json({ success: false, error: 'Sonos is not answering right now' }, { status: 502 })
  }
  const { groups } = mapGroups(groupsRes.body)
  const groupIds = resolveGroupIds(groups, schedule.player_ids)
  if (!groupIds.length) {
    return NextResponse.json({ success: false, error: 'None of this schedule’s speakers are online' }, { status: 409 })
  }

  const out = await applyOpen(db, {
    token: tok.token,
    schedule,
    plan,
    groups,
    groupIds,
    nowMs,
  })

  if (!out.ok && out.reason === 'sonos') {
    // Nothing stamped — an unapplied window is retried by the next cron
    // tick, which is what a transient failure deserves.
    return NextResponse.json({ success: false, error: 'That did not work' }, { status: 502 })
  }
  if (!out.ok) {
    // reason === 'stamp': the music IS playing; only the bookkeeping
    // failed. Report success with a warning rather than telling the
    // operator it did not work. Note what an unstamped open costs: the
    // cron sees the window as unapplied and re-opens it on its next tick,
    // restarting the playlist, until the write lands.
    return NextResponse.json({ success: true, warning: 'applied, but the record did not save' })
  }

  return NextResponse.json({ success: true, groups: groupIds })
}
