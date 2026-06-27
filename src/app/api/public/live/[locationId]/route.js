// GET /api/public/live/[locationId]
//
// Public — no auth. Powers the in-studio TV display at
// /tv/[locationId]. Returns enough state to render the live class
// board: per-attendee first-name + initial, current BPM, current
// zone, accumulated UN1T Points + zone breakdown so far.
//
// Privacy: full names, contact ids, MAC addresses are NOT exposed.
// The TV display lives in a public room so the bar is "what would
// I be comfortable showing the next class waiting in the lobby" —
// first name + last initial is the cap.
//
// Refresh: page polls every 2s. force-dynamic + revalidate=0 so
// edge caches don't kick in.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { summariseSession, zoneForBpm } from '@/lib/heart-rate'
import { isBridgeOnline, latestBridgeSeenMs, maskStrapLabel } from '@/lib/bridge-samples'
import { getAvailableStraps } from '@/lib/live-class'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RECENT_BPM_WINDOW_MS = 30 * 1000   // moving-avg window for "current"
const STALE_AFTER_MS = 2 * 60 * 1000     // strap silent for 2min → flag

export async function GET(_request, props) {
  const params = await props.params;
  const db = createServerClient()
  const locationId = params.locationId
  const nowMs = Date.now()

  // Confirm the location exists. Also lets the TV page render the
  // studio name in the header without a separate API call.
  const { data: location } = await db
    .from('locations')
    .select('id, name')
    .eq('id', locationId)
    .single()
  if (!location) {
    return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404 })
  }

  // Bridge liveness for the TV connection dot. Keyed off last_seen_at
  // freshness, not the status column — a Pi that loses power can't send
  // a final 'offline', so status would lie; a stale heartbeat can't.
  const { data: bridges } = await db
    .from('ble_bridges')
    .select('last_seen_at')
    .eq('location_id', locationId)
  const bridgeSeenMs = latestBridgeSeenMs(bridges)
  const bridge = {
    online: isBridgeOnline(bridges, nowMs),
    last_seen_at: bridgeSeenMs > 0 ? new Date(bridgeSeenMs).toISOString() : null,
  }

  // Unpaired straps — broadcasting but not attached to any open session.
  const rawStraps = await getAvailableStraps(db, locationId)
  const availableStraps = (rawStraps || []).map((s) => ({
    label: maskStrapLabel(s.device_key),
    protocol: s.protocol,
    currentBpm: s.lastBpm ?? null,
  }))

  // Open sessions at this location.
  const { data: sessions } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, device_identifier, started_at, max_hr_used, last_sample_at, contacts!contact_id(id, name, location_id)')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: true })

  // CLASS-TIMER — the live timer run for the TV banner (structure + timestamps
  // only, no PII; the TV computes the tick locally). Null when none is running.
  const { data: timerRun } = await db
    .from('class_timer_runs')
    .select('id, name, status, started_at, paused_at, paused_accum_ms, elapsed_offset_ms, structure_snapshot')
    .eq('location_id', locationId)
    .in('status', ['running', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({
      ok: true,
      server_time: new Date().toISOString(),
      location: { id: location.id, name: location.name },
      bridge,
      sessions: [],
      available_straps: availableStraps,
      timer: timerRun || null,
    })
  }

  const sessionIds = sessions.map((s) => s.id)

  // Two queries:
  //   - last 30s of samples per session (for current BPM)
  //   - all samples per session (for cumulative zones + points)
  // Could combine but the live-window aggregation is small enough
  // to keep readable as two passes.
  const recentSince = new Date(nowMs - RECENT_BPM_WINDOW_MS).toISOString()
  const [{ data: recentSamples }, { data: allSamples }] = await Promise.all([
    db.from('hr_samples')
      .select('session_id, recorded_at, bpm')
      .in('session_id', sessionIds)
      .gte('recorded_at', recentSince),
    db.from('hr_samples')
      .select('session_id, recorded_at, bpm')
      .in('session_id', sessionIds)
      .order('recorded_at', { ascending: true }),
  ])

  // Bucket per session.
  const recentBySession = new Map()
  const allBySession = new Map()
  for (const s of recentSamples || []) {
    const arr = recentBySession.get(s.session_id) || []
    arr.push(s.bpm)
    recentBySession.set(s.session_id, arr)
  }
  for (const s of allSamples || []) {
    const arr = allBySession.get(s.session_id) || []
    arr.push(s)
    allBySession.set(s.session_id, arr)
  }

  const tiles = sessions.map((sess) => {
    const recent = recentBySession.get(sess.id) || []
    const currentBpm = recent.length > 0
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : null
    const zone = currentBpm != null ? zoneForBpm(currentBpm, sess.max_hr_used) : null

    const samples = allBySession.get(sess.id) || []
    const summary = summariseSession(samples, sess.max_hr_used)

    // HR-CLASS-ALLOC.2 — anonymous (null-contact) walk-in sessions are labelled
    // by their device id (e.g. "ant:45075") instead of a name.
    const fullName = sess.contacts?.name || 'Member'
    const parts = fullName.trim().split(/\s+/)
    const firstName = parts[0] || 'Member'
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + '.' : ''
    // Anonymous walk-in sessions are labelled by their strap — but mask it
    // (never a full BLE MAC on the public TV), same privacy floor as the
    // unpaired-strap tiles above.
    const displayName = sess.contacts
      ? (lastInitial ? `${firstName} ${lastInitial}` : firstName)
      : (sess.device_identifier ? maskStrapLabel(sess.device_identifier) : 'Guest')

    const stale = sess.last_sample_at
      ? (nowMs - new Date(sess.last_sample_at).getTime()) > STALE_AFTER_MS
      : false

    return {
      id: sess.id,
      displayName,
      currentBpm,
      currentZone: zone ? { id: zone.id, label: zone.label, color: zone.color } : null,
      zonesSeconds: summary.zonesSeconds,
      effortPoints: summary.effortPoints,
      peakBpm: summary.peakHrBpm,
      avgBpm: summary.avgHrBpm,
      startedAt: sess.started_at,
      stale,
    }
  })

  // Sort by effort points desc — leaderboard feel. Falls back to
  // started_at for ties. Stale sessions sink to the bottom.
  tiles.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1
    if ((b.effortPoints || 0) !== (a.effortPoints || 0)) {
      return (b.effortPoints || 0) - (a.effortPoints || 0)
    }
    return new Date(a.startedAt) - new Date(b.startedAt)
  })

  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
    location: { id: location.id, name: location.name },
    bridge,
    sessions: tiles,
    available_straps: availableStraps,
    timer: timerRun || null,
  })
}
