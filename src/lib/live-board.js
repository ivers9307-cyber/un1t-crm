// Live HR board payload builder — shared by the two public entrypoints:
//   - /api/public/live/[locationId]   (legacy, location-keyed; P0-3 transition)
//   - /api/public/tv-live/[token]     (P0-3 token-gated; resolves the location
//                                       from tv_displays.token first)
// Both return the IDENTICAL board payload so the TV client is agnostic to which
// URL it polls. Keeping the builder here (not in a route) means there is a
// single privacy/opt-out filter to maintain.
//
// Privacy floor (unchanged): first name + last initial only, no contact ids, no
// MAC addresses. DECISION #1 (mig 348): members who opted OUT of the public
// leaderboard are dropped from the tiles here — their session still exists and
// still scores for them, it is just not rendered publicly. Anonymous walk-in
// (null-contact) sessions have no member to opt out, so they are always kept.

import { zoneForBpm } from '@/lib/heart-rate'
import { isBridgeOnline, latestBridgeSeenMs, maskStrapLabel } from '@/lib/bridge-samples'
import { getAvailableStraps } from '@/lib/live-class'
import { resolveCurrentClassForTv } from '@/lib/class-occurrences'
import { dublinTimeLabel } from '@/lib/dublin-time'
import { selectAll } from '@/lib/select-all'

const RECENT_BPM_WINDOW_MS = 30 * 1000   // moving-avg window for "current"
const STALE_AFTER_MS = 2 * 60 * 1000     // strap silent for 2min → flag

/**
 * Build the full live-board payload for one location.
 *
 * @param {object} db        service-role Supabase client
 * @param {object} opts
 * @param {{ id: string, name: string }} opts.location  the resolved location row
 * @param {number} [opts.nowMs]
 * @returns {Promise<object>} the JSON body ({ ok, server_time, location, bridge, sessions, available_straps, timer, current_class })
 */
export async function buildLiveBoardPayload(db, { location, nowMs = Date.now() }) {
  const locationId = location.id

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
  // Staleness cutoff (audit C11): a strap only renders while its bridge has
  // ACTUALLY seen it inside the same 2-minute window the session tiles use —
  // without this, a Pi dying mid-class froze phantom BPMs on the TV
  // indefinitely (last_seen_straps is only overwritten by the next scan
  // report, which a dead bridge never sends). A strap with no parseable
  // seen_at can't prove freshness, so it is dropped too. Stale entries just
  // disappear — the payload shape is unchanged.
  const rawStraps = await getAvailableStraps(db, locationId)
  const availableStraps = (rawStraps || [])
    .filter((s) => {
      const seenMs = s.seenAt ? new Date(s.seenAt).getTime() : NaN
      return Number.isFinite(seenMs) && (nowMs - seenMs) <= STALE_AFTER_MS
    })
    .map((s) => ({
      label: maskStrapLabel(s.device_key),
      protocol: s.protocol,
      currentBpm: s.lastBpm ?? null,
    }))

  // Open sessions at this location. The running HR aggregate (zones_seconds /
  // effort_points / peak_hr_bpm / avg_hr_bpm) is maintained INCREMENTALLY at
  // ingest (mig 354; src/lib/bridge-samples.js insertHrSamples), so we read it
  // straight off the row — NO per-poll re-scan of every sample in the class.
  const { data: rawSessions } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, device_identifier, started_at, max_hr_used, last_sample_at, zones_seconds, effort_points, peak_hr_bpm, avg_hr_bpm, contacts!contact_id(id, name, location_id, hr_leaderboard_opt_out)')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: true })

  // DECISION #1 (mig 348) — drop tiles for members who opted OUT of the public
  // leaderboard. Their session still exists and still scores for THEM; it is
  // just not rendered on the public TV. A null-contact (anonymous walk-in)
  // session has no member to opt out, so it is always kept.
  const sessions = (rawSessions || []).filter((s) => !s.contacts?.hr_leaderboard_opt_out)

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

  const liveClass = await resolveCurrentClassForTv(db, { locationId, nowMs })
  const currentClass = liveClass
    ? { class_name: liveClass.class_name, program: liveClass.program, starts_at: liveClass.starts_at, starts_at_label: dublinTimeLabel(liveClass.starts_at), glofox_event_id: liveClass.glofox_event_id }
    : null

  if (!sessions || sessions.length === 0) {
    return {
      ok: true,
      server_time: new Date().toISOString(),
      location: { id: location.id, name: location.name },
      bridge,
      sessions: [],
      available_straps: availableStraps,
      timer: timerRun || null,
      current_class: currentClass,
    }
  }

  const sessionIds = sessions.map((s) => s.id)

  // ONE small read: the last 30s of samples per session, for the "current BPM"
  // moving average on each tile. The cumulative zones/points/peak/avg are NO
  // LONGER scanned here — they're maintained incrementally at ingest and read
  // off the session row above (mig 354, audit W2/#11), so the O(minutes ×
  // attendees) full-class re-scan every 2s poll is gone.
  //
  // This read must still page: the 30s window breaches the 1000-row cap above
  // ~33 concurrent straps (33 × 30 samples > 1000), which would truncate
  // current-BPM tiles. selectAll pages by a stable order until the final short
  // page.
  const recentSince = new Date(nowMs - RECENT_BPM_WINDOW_MS).toISOString()
  const recentSamples = await selectAll((from, to) => db
    .from('hr_samples')
    .select('session_id, recorded_at, bpm')
    .in('session_id', sessionIds)
    .gte('recorded_at', recentSince)
    .order('recorded_at', { ascending: true })
    .range(from, to))

  // Bucket per session.
  const recentBySession = new Map()
  for (const s of recentSamples || []) {
    const arr = recentBySession.get(s.session_id) || []
    arr.push(s.bpm)
    recentBySession.set(s.session_id, arr)
  }

  const tiles = sessions.map((sess) => {
    const recent = recentBySession.get(sess.id) || []
    const currentBpm = recent.length > 0
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : null
    const zone = currentBpm != null ? zoneForBpm(currentBpm, sess.max_hr_used) : null

    // Cumulative aggregate straight off the row (incrementally maintained at
    // ingest). Normalise jsonb string keys + null-on-fresh-session to a stable
    // shape so the payload keys never change. effort_points/peak/avg are null
    // until the session's first batch — coalesce points to 0, leave peak/avg
    // null (same as summariseSession returned for an empty session).
    const zonesSeconds = normaliseZones(sess.zones_seconds)
    const effortPoints = Number(sess.effort_points) || 0
    const peakBpm = sess.peak_hr_bpm != null ? Number(sess.peak_hr_bpm) : null
    const avgBpm = sess.avg_hr_bpm != null ? Number(sess.avg_hr_bpm) : null

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
      zonesSeconds,
      effortPoints,
      peakBpm,
      avgBpm,
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

  return {
    ok: true,
    server_time: new Date().toISOString(),
    location: { id: location.id, name: location.name },
    bridge,
    sessions: tiles,
    available_straps: availableStraps,
    timer: timerRun || null,
    current_class: currentClass,
  }
}

/**
 * Normalise a persisted zones_seconds into the exact { 1..5: number } shape the
 * TV client expects, tolerating jsonb string keys and null (fresh session).
 * Mirrors what summariseSession returned before the aggregate moved onto the
 * row, so the payload shape is byte-stable.
 */
function normaliseZones(zonesSeconds) {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  if (zonesSeconds && typeof zonesSeconds === 'object') {
    for (const id of [1, 2, 3, 4, 5]) {
      out[id] = Number(zonesSeconds[id] ?? zonesSeconds[String(id)] ?? 0) || 0
    }
  }
  return out
}
