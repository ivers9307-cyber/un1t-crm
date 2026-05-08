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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const RECENT_BPM_WINDOW_MS = 30 * 1000   // moving-avg window for "current"
const STALE_AFTER_MS = 2 * 60 * 1000     // strap silent for 2min → flag

export async function GET(_request, { params }) {
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

  // Open sessions at this location.
  const { data: sessions } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, started_at, max_hr_used, last_sample_at, contacts!inner(id, name, location_id)')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: true })

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({
      ok: true,
      server_time: new Date().toISOString(),
      location: { id: location.id, name: location.name },
      sessions: [],
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

    const fullName = sess.contacts?.name || 'Member'
    const parts = fullName.trim().split(/\s+/)
    const firstName = parts[0] || 'Member'
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + '.' : ''

    const stale = sess.last_sample_at
      ? (nowMs - new Date(sess.last_sample_at).getTime()) > STALE_AFTER_MS
      : false

    return {
      id: sess.id,
      displayName: lastInitial ? `${firstName} ${lastInitial}` : firstName,
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
    sessions: tiles,
  })
}
