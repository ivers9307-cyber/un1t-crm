// NOTIF.5 — daily sweep of device_tokens.last_seen_at < NOW - 90 days.
//
// last_seen_at is updated on every app launch (the mobile app POSTs
// to /api/mobile/device-tokens which upserts with last_seen_at=now).
// A token that hasn't been touched in 90 days means the phone hasn't
// opened the app in three months. By that point the token is stale
// for all practical purposes — Expo might or might not still accept
// it, but the user has clearly stopped using the app on that device.
//
// Why not rely on push.js's DeviceNotRegistered pruning?
//   push.js prunes ON SEND. A device that we never try to push to
//   (user opted out of notify_<category> for everything we send)
//   never gets pruned. As permission settings drift over time, dead
//   tokens accumulate. This sweep is the floor.
//
// Idempotent. Daily at 04:00 UTC (after the 03:00 + 03:30 sync jobs).
// CRON_SECRET bearer auth, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logWarn, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 90

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoffIso = new Date(Date.now() - STALE_AFTER_DAYS * 86400 * 1000).toISOString()

  // Pull-then-delete for the count + an audit-friendly log. The
  // table is tiny — 4 rows in prod today, max plausible scale a
  // few hundred when every staff member has a phone.
  const { data: stale, error: selErr } = await db
    .from('device_tokens')
    .select('id, user_id, platform, device_name, last_seen_at')
    .lt('last_seen_at', cutoffIso)

  if (selErr) {
    logError('cron-sweep-stale-push-tokens', 'select failed', { err: selErr })
    return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 })
  }

  const ids = (stale || []).map(t => t.id)
  let deleted = 0
  if (ids.length > 0) {
    const { error: delErr } = await db
      .from('device_tokens')
      .delete()
      .in('id', ids)
    if (delErr) {
      logError('cron-sweep-stale-push-tokens', 'delete failed', { err: delErr })
      return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 })
    }
    deleted = ids.length

    logInfo('cron-sweep-stale-push-tokens', 'pruned stale tokens', {
      count: deleted,
      cutoff_iso: cutoffIso,
      affected_users: [...new Set(stale.map(t => t.user_id))].length,
      samples: stale.slice(0, 5).map(t => ({
        platform: t.platform,
        device_name: t.device_name,
        last_seen_at: t.last_seen_at,
      })),
    })
  }

  await stampHeartbeat('sweep-stale-push-tokens').catch((err) =>
    logWarn('cron-sweep-stale-push-tokens', 'heartbeat failed', { err }))

  return NextResponse.json({
    ok: true,
    deleted,
    cutoff_iso: cutoffIso,
    stale_after_days: STALE_AFTER_DAYS,
  })
}
