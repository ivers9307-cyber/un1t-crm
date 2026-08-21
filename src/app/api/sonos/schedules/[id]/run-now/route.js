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
// Now it applies the window through the same volume-then-favourite path the
// reconcile uses and stamps last_applied as an open, exactly as a
// cron-driven open would. No wait, and the close's precondition is written
// rather than destroyed.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds, planAction } from '@/lib/sonos/groups'
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

  let allOk = true
  for (const groupId of groupIds) {
    // Volume first: after loadFavorite the opening seconds would play at
    // the previous window's level.
    const v = await sonosSetGroupVolume(tok.token, groupId, plan.volume)
    if (!v.ok) { allOk = false; logWarn('sonos-run-now', 'setVolume failed', { groupId, statusCode: v.statusCode }); continue }
    const f = await sonosLoadFavorite(tok.token, groupId, plan.favoriteId)
    if (!f.ok) { allOk = false; logWarn('sonos-run-now', 'loadFavorite failed', { groupId, statusCode: f.statusCode }) }
  }

  if (!allOk) {
    // Do NOT stamp last_applied on a failure — an unapplied window is
    // retried by the next cron tick, which is what a transient failure
    // deserves. Stamping would cost the whole window.
    return NextResponse.json({ success: false, error: 'That did not work' }, { status: 502 })
  }

  const nowIso = new Date(nowMs).toISOString()
  const primary = groupIds[0]
  const group = groups.find((g) => g.id === primary)
  // window_on_at MUST stay a raw number. A string makes planAction's
  // equality never match, so every tick re-opens and loadFavorite restarts
  // the playlist every 60 seconds.
  const { error: upErr } = await db
    .from('sonos_schedules')
    .update({
      last_applied: { window_on_at: plan.windowOnAt, action: 'open', at: nowIso },
      last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', schedule.id)
    .eq('location_id', locationId)
  if (upErr) {
    logWarn('sonos-run-now', 'state write failed', { scheduleId: schedule.id, error: upErr.message })
    // The music IS playing; only the bookkeeping failed. Report success
    // with a warning rather than telling the operator it did not work.
    return NextResponse.json({ success: true, warning: 'applied, but the record did not save' })
  }

  return NextResponse.json({ success: true, groups: groupIds })
}
