// SONOSLIVE.5 — live readout for the control strip.
//
// Playback state comes from the household groups response already fetched
// to resolve the group, so it costs no extra call. Volume and metadata are
// two more GETs. Polled every 10s while a strip is open: 12 requests/min
// against a 1000/min quota.
//
// Every metadata field is nullable per Sonos, so the consumer must degrade
// to "playing, no track detail" rather than rendering blanks.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosGetGroupVolume, sonosGetMetadata } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds } from '@/lib/sonos/groups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const scheduleId = new URL(request.url).searchParams.get('schedule_id') || ''
  if (!uuidLike.safeParse(scheduleId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return NextResponse.json({ success: true, live: false, reason: 'not_configured' })

  const db = createServerClient()
  const { data: schedule, error } = await db
    .from('sonos_schedules')
    .select('id, player_ids')
    .eq('id', scheduleId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!schedule) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) return NextResponse.json({ success: true, live: false, reason: tok.reason })

  const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) {
    return NextResponse.json({ success: true, live: false, reason: 'unreachable', statusCode: groupsRes.statusCode })
  }
  const { groups } = mapGroups(groupsRes.body)
  const groupIds = resolveGroupIds(groups, schedule.player_ids)
  if (!groupIds.length) return NextResponse.json({ success: true, live: false, reason: 'no_group' })

  const groupId = groupIds[0]
  const group = groups.find((g) => g.id === groupId)

  const [volRes, metaRes] = await Promise.all([
    sonosGetGroupVolume(tok.token, groupId),
    sonosGetMetadata(tok.token, groupId),
  ])

  const track = metaRes.body?.currentItem?.track || null

  return NextResponse.json({
    success: true,
    live: true,
    groupId,
    playbackState: group?.playbackState || null,
    volume: volRes.ok ? (volRes.body?.volume ?? null) : null,
    muted: volRes.ok ? (volRes.body?.muted ?? null) : null,
    fixedVolume: volRes.ok ? (volRes.body?.fixed === true) : false,
    volumeFailed: !volRes.ok,
    track: track
      ? {
          name: track.name || null,
          artist: track.artist?.name || null,
          album: track.album?.name || null,
          imageUrl: track.imageUrl || null,
        }
      : null,
    source: metaRes.body?.container?.name || metaRes.body?.container?.service?.name || null,
  })
}
