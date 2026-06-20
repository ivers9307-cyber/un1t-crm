// Live class operator helpers — read open sessions + available
// straps for the coach view, and the write-side operations:
//   - pairOverride()          create a strap_assignments + session
//                              for a walk-in / lent strap that
//                              isn't on contact_devices yet
//   - endSession()             stamp ended_at + finalise zones +
//                              points from hr_samples
//   - endAllAtLocation()       same for every open session at L
//
// Auto-association (mig 112) is the default path — most members
// don't need any of this. These helpers exist for the edge cases
// the coach needs to handle in real time.

import { logWarn } from '@/lib/log'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { lookupBookedMember, resolveClassLinkSource } from '@/lib/class-bookings'
import { resolveMaxHr, summariseSession } from '@/lib/heart-rate'
import { sendPostClassEmail } from '@/lib/hr-post-class-email'
import { sendCustomerPush } from '@/lib/customer-push'
import { runDetectionForSession } from '@/lib/achievements'
import { enqueueExportsForSession } from '@/lib/external-export'
import { buildSessionPush, buildGoalPush, buildTargetHitPush, buildTierUpPush, periodKey } from '@/lib/customer-notifications'
import { GOAL_DEFS, computeProgress, startOfMonth, startOfIsoWeek } from '@/lib/goals'
import { tierForMonths, nextTier } from '@/lib/tiers'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

const RECENT_SAMPLE_WINDOW_MS = 30 * 1000  // current-BPM averaging window

/**
 * Returns every open heart_rate_sessions at this location plus
 * recent-sample summary so the live view can render current BPM
 * + zone for each. Joins to contacts for the display name.
 *
 * @param {SupabaseClient} db
 * @param {string} locationId
 * @returns {Promise<Array<{
 *   id: string,
 *   contactId: string,
 *   contactName: string,
 *   contactFirstName: string,
 *   bookingId: string|null,
 *   startedAt: string,
 *   maxHrUsed: number,
 *   deviceIdentifier: string|null,
 *   lastSampleAt: string|null,
 *   currentBpm: number|null,
 *   recentBpms: number[],
 * }>>}
 */
export async function getLiveSessions(db, locationId, nowMs = Date.now()) {
  const { data: sessions, error } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, booking_id, started_at, max_hr_used, device_identifier, last_sample_at, contacts!contact_id(id, name, location_id, glofox_member_id)')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })

  if (error) {
    logWarn('live-class', 'getLiveSessions failed', { err: error, locationId })
    return []
  }
  if (!sessions || sessions.length === 0) return []

  // Pull last 30s of samples per session in one go. For 30 attendees
  // that's ~30 × 30 = 900 rows, well within fast-query territory.
  const sessionIds = sessions.map((s) => s.id)
  const since = new Date(nowMs - RECENT_SAMPLE_WINDOW_MS).toISOString()
  const { data: samples } = await db
    .from('hr_samples')
    .select('session_id, recorded_at, bpm')
    .in('session_id', sessionIds)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: false })

  const recentBySession = new Map()
  for (const s of samples || []) {
    const arr = recentBySession.get(s.session_id) || []
    arr.push(s.bpm)
    recentBySession.set(s.session_id, arr)
  }

  return sessions.map((s) => {
    const recent = recentBySession.get(s.id) || []
    const currentBpm = recent.length > 0
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : null
    // HR-CLASS-ALLOC.2 — anonymous (null-contact) walk-ins are labelled by their
    // device id; glofoxMemberId lets the roster panel join sessions to bookings.
    const isAnon = !s.contacts
    const label = isAnon ? (s.device_identifier || 'Guest') : (s.contacts?.name || 'Member')
    return {
      id: s.id,
      contactId: s.contact_id,
      glofoxMemberId: s.contacts?.glofox_member_id ?? null,
      contactName: label,
      contactFirstName: isAnon ? label : label.split(' ')[0],
      bookingId: s.booking_id,
      startedAt: s.started_at,
      maxHrUsed: s.max_hr_used,
      deviceIdentifier: s.device_identifier,
      lastSampleAt: s.last_sample_at,
      currentBpm,
      recentBpms: recent.slice(0, 8), // most recent 8 samples for sparkline
    }
  })
}

/**
 * Read every bridge at the location and union their last_seen_straps.
 * Filters out straps already linked to an open session (so the coach
 * only sees genuinely-available straps to pair). Straps are
 * identified by a protocol-aware device_key (ant:… or ble:…).
 *
 * @returns {Promise<Array<{ device_key: string, protocol: string,
 *   name: string|null, rssi: number|null, lastBpm: number|null,
 *   seenAt: string, bridgeId: string, bridgeName: string }>>}
 */
export async function getAvailableStraps(db, locationId) {
  const { data: bridges } = await db
    .from('ble_bridges')
    .select('id, name, status, last_seen_at, last_seen_straps')
    .eq('location_id', locationId)

  const all = []
  for (const b of bridges || []) {
    for (const s of b.last_seen_straps || []) {
      if (!s.device_key) continue
      all.push({
        device_key: s.device_key,
        protocol: s.device_key.startsWith('ant:') ? 'ant' : 'ble',
        name: s.name || null,
        rssi: s.rssi ?? null,
        lastBpm: s.last_bpm ?? null,
        seenAt: s.seen_at,
        bridgeId: b.id,
        bridgeName: b.name,
      })
    }
  }
  if (all.length === 0) return []

  // Filter out straps already routing to a session (auto OR
  // override). The coach UI only wants to surface unrouted straps.
  const deviceKeys = all.map((s) => s.device_key)
  const { data: openSessions } = await db
    .from('heart_rate_sessions')
    .select('device_identifier')
    .eq('location_id', locationId)
    .is('ended_at', null)
    .in('device_identifier', deviceKeys)

  const inUse = new Set((openSessions || []).map((s) => s.device_identifier))
  return all.filter((s) => !inUse.has(s.device_key))
}

/**
 * Manual override: pair a strap to a contact, creating a fresh
 * heart_rate_sessions row + strap_assignments row. Used for walk-ins
 * and lent straps where contact_devices auto-association isn't going
 * to fire (the contact doesn't have this MAC registered).
 *
 * Idempotent-ish: if the contact already has an open session at this
 * location, we link the new strap to that session rather than creating
 * a parallel one (member swapped straps mid-class — keep their stats
 * cumulative).
 */
export async function pairOverride(db, { locationId, bridgeId, contactId, deviceKey, bookingId = null, nowMs = Date.now() }) {
  if (!deviceKey) return { ok: false, error: 'A strap device_key is required' }

  // Snapshot max HR for the session row.
  const { data: contact } = await db
    .from('contacts')
    .select('id, max_hr_override, dob, glofox_member_id')
    .eq('id', contactId)
    .single()
  if (!contact) return { ok: false, error: 'Contact not found' }
  const maxHr = resolveMaxHr(contact, nowMs)

  // Which Glofox class is running right now? Stamp it on the session so
  // coach-paired members get the same class link as the auto-ingest path
  // (HR-CLASS-ALLOC.1/.2): 'booked' if the member was booked into this class,
  // else 'presence'. Best-effort — a strap paired outside any class still
  // creates a session, just without a class link.
  const liveClass = await resolveCurrentOccurrence(db, { locationId, nowMs })
  const booked = liveClass ? await lookupBookedMember(db, {
    locationId, glofoxEventId: liveClass.glofox_event_id, glofoxMemberId: contact?.glofox_member_id,
  }) : false
  const linkSource = resolveClassLinkSource({ liveClass, booked }) // 'booked' | 'presence' | null

  // Find or create a session.
  const { data: existing } = await db
    .from('heart_rate_sessions')
    .select('id, device_identifier, glofox_event_id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let sessionId = existing?.id
  if (!sessionId) {
    const { data: created, error: createErr } = await db
      .from('heart_rate_sessions')
      .insert({
        contact_id: contactId,
        location_id: locationId,
        booking_id: bookingId,
        source: 'ble_bridge',
        device_identifier: deviceKey,
        started_at: new Date(nowMs).toISOString(),
        max_hr_used: maxHr,
        glofox_event_id: liveClass?.glofox_event_id ?? null,
        class_name: liveClass?.class_name ?? null,
        class_link_source: linkSource,
      })
      .select('id')
      .single()
    if (createErr || !created) {
      return { ok: false, error: createErr?.message || 'Session create failed' }
    }
    sessionId = created.id
  } else {
    // Existing open session — follow a mid-class strap swap, and backfill
    // the class link if the session predates the occurrence sync.
    const patch = {}
    if (existing.device_identifier !== deviceKey) patch.device_identifier = deviceKey
    if (!existing.glofox_event_id && liveClass) {
      patch.glofox_event_id = liveClass.glofox_event_id
      patch.class_name = liveClass.class_name
      patch.class_link_source = linkSource
    }
    if (Object.keys(patch).length) {
      await db.from('heart_rate_sessions').update(patch).eq('id', sessionId)
    }
  }

  // strap_assignments override row.
  const { error: saErr } = await db
    .from('strap_assignments')
    .insert({
      ble_bridge_id: bridgeId,
      contact_id: contactId,
      strap_identifier: deviceKey,
      booking_id: bookingId,
      heart_rate_session_id: sessionId,
    })
  if (saErr) {
    logWarn('live-class', 'pairOverride strap_assignments insert failed', { err: saErr })
    return { ok: false, error: saErr.message }
  }

  return { ok: true, sessionId }
}

/**
 * End a single session: stamp ended_at, finalise zones_seconds /
 * effort_points / avg / peak from the persisted hr_samples. Also
 * closes any active strap_assignments tied to the session.
 */
export async function endSession(db, sessionId, { nowMs = Date.now() } = {}) {
  const { data: session, error: sErr } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, location_id, max_hr_used, ended_at, class_name')
    .eq('id', sessionId)
    .single()
  if (sErr || !session) return { ok: false, error: 'Session not found' }
  if (session.ended_at) return { ok: true, alreadyEnded: true }

  // Pull all samples for this session and summarise.
  const { data: samples } = await db
    .from('hr_samples')
    .select('recorded_at, bpm')
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: true })

  const summary = summariseSession(samples || [], session.max_hr_used)
  const endedAt = new Date(nowMs).toISOString()

  const { error: updErr } = await db
    .from('heart_rate_sessions')
    .update({
      ended_at: endedAt,
      zones_seconds: summary.zonesSeconds,
      effort_points: summary.effortPoints,
      avg_hr_bpm: summary.avgHrBpm,
      peak_hr_bpm: summary.peakHrBpm,
    })
    .eq('id', sessionId)
  if (updErr) return { ok: false, error: updErr.message }

  // Close strap_assignments rows for this session (if any).
  await db
    .from('strap_assignments')
    .update({ ended_at: endedAt })
    .eq('heart_rate_session_id', sessionId)
    .is('ended_at', null)

  // HR-CLASS-ALLOC.2 — anonymous (null-contact) walk-in sessions still get
  // zones/points from summariseSession above, but skip every contact-bound
  // side-effect: no member to email, attach achievements to, or export for.
  if (session.contact_id) {
    // Best-effort post-class email. Doesn't propagate errors — the
    // sender already swallows + logs everything internally. The
    // session is finalised regardless of email outcome.
    sendPostClassEmail(db, sessionId).catch((err) => {
      logWarn('live-class', 'post-class email scheduling threw', { err, sessionId })
    })

    // Best-effort: achievement detection + ONE consolidated session push.
    // Leads with any achievement unlocked this session, else the session-
    // ready summary. Never blocks/fails finalisation.
    try {
      const det = await runDetectionForSession(db, sessionId)
      const unlocked = det && det.ok && Array.isArray(det.unlocked) ? det.unlocked : []
      if (unlocked.length) {
        await db
          .from('contact_achievements')
          .update({ notified_at: new Date(nowMs).toISOString() })
          .eq('source_session_id', sessionId)
          .is('notified_at', null)
      }
      await sendCustomerPush(
        db,
        session.contact_id,
        buildSessionPush({
          effortPoints: summary.effortPoints,
          className: session.class_name,
          sessionId,
          unlocked,
        })
      )
    } catch (err) {
      logWarn('live-class', 'engagement notify threw', { err, sessionId })
    }

    // Best-effort: celebrate any active goal completed (this period) by this
    // session. Idempotent per (goal, period) via customer_engagement_nudges.
    try {
      const { data: goals } = await db
        .from('contact_goals')
        .select('id, kind, target_value')
        .eq('contact_id', session.contact_id)
        .eq('is_active', true)
        .is('archived_at', null)
      if (goals && goals.length) {
        // Lower bound must cover BOTH the current ISO week and the current
        // month: computeProgress filters weekly goals to the ISO-week start,
        // which can fall in the PREVIOUS month near a boundary. Fetch from
        // whichever anchor is earlier; computeProgress re-filters per goal.
        const goalRef = new Date(nowMs)
        const sinceIso = new Date(
          Math.min(startOfIsoWeek(goalRef).getTime(), startOfMonth(goalRef).getTime())
        ).toISOString()
        const { data: gSessions, error: gErr } = await db
          .from('heart_rate_sessions')
          .select('started_at, effort_points')
          .eq('contact_id', session.contact_id)
          .not('ended_at', 'is', null)
          .gte('started_at', sinceIso)
        if (gErr) logWarn('live-class', 'goal sessions load failed', { gErr, sessionId })
        for (const goal of goals) {
          const def = GOAL_DEFS[goal.kind]
          if (!def) continue
          const { current } = computeProgress(goal, gSessions || [], new Date(nowMs))
          if (current < goal.target_value) continue
          const dedupKey = `${goal.id}:${periodKey(def.period, nowMs)}`
          const { data: ins, error: insErr } = await db
            .from('customer_engagement_nudges')
            .insert({ contact_id: session.contact_id, type: 'goal_complete', dedup_key: dedupKey })
            .select('id')
          if (insErr || !ins || !ins.length) continue // already celebrated this period, or insert failed
          await sendCustomerPush(db, session.contact_id, buildGoalPush({ goal, def }))
        }
      }
    } catch (err) {
      logWarn('live-class', 'goal-completion notify threw', { err, sessionId })
    }

    // Best-effort: monthly target + tier banking. Banks the month the instant
    // this-month points cross the gym target; tier is derived from the count of
    // banked months. Idempotent per (contact, month) via the unique constraint.
    try {
      const { data: loc } = await db
        .from('locations').select('settings').eq('id', session.location_id).maybeSingle()
      const target = Number(loc?.settings?.customer_agent?.monthly_points_target) || 0
      if (target > 0) {
        const monthKey = periodKey('month', nowMs) // 'YYYY-MM'
        const monthStartIso = startOfMonth(new Date(nowMs)).toISOString()
        const { data: monthSessions } = await db
          .from('heart_rate_sessions')
          .select('effort_points')
          .eq('contact_id', session.contact_id)
          .not('ended_at', 'is', null)
          .gte('started_at', monthStartIso)
        const monthPoints = (monthSessions || []).reduce((a, s) => a + (Number(s.effort_points) || 0), 0)
        if (monthPoints >= target) {
          const { data: banked, error: bankErr } = await db
            .from('member_monthly_targets')
            .insert({
              contact_id: session.contact_id, location_id: session.location_id,
              period_month: monthKey, points: monthPoints, target,
            })
            .select('id')
          if (!bankErr && banked && banked.length) {
            const { count } = await db
              .from('member_monthly_targets')
              .select('id', { count: 'exact', head: true })
              .eq('contact_id', session.contact_id)
            const monthsHit = count || 1
            const newTier = tierForMonths(monthsHit)
            const oldTier = tierForMonths(monthsHit - 1)
            if (newTier && (!oldTier || newTier.slug !== oldTier.slug)) {
              const { data: nins } = await db
                .from('customer_engagement_nudges')
                .insert({ contact_id: session.contact_id, type: 'tier_up', dedup_key: newTier.slug })
                .select('id')
              if (nins && nins.length) {
                await sendCustomerPush(db, session.contact_id, buildTierUpPush({ tier: newTier, monthsHit }))
              }
            } else {
              const monthLabel = MONTH_NAMES[new Date(nowMs).getUTCMonth()]
              await sendCustomerPush(
                db, session.contact_id,
                buildTargetHitPush({ monthLabel, monthsHit, next: nextTier(monthsHit) })
              )
            }
          }
        }
      }
    } catch (err) {
      logWarn('live-class', 'tier banking threw', { err, sessionId })
    }

    // Best-effort: queue external-system exports for this session.
    // The actual upload happens out-of-band via the cron worker.
    enqueueExportsForSession(db, {
      id: sessionId,
      contact_id: session.contact_id,
      ended_at: endedAt,
    }).catch((err) => {
      logWarn('live-class', 'export enqueue threw', { err, sessionId })
    })
  }

  return { ok: true, summary }
}

/**
 * End every open session at the location. One round-trip per
 * session — for a 30-person class that's 30 SQL writes. Acceptable
 * since end-of-class is a once-per-class operator action.
 */
export async function endAllAtLocation(db, locationId, { nowMs = Date.now() } = {}) {
  const { data: sessions } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('location_id', locationId)
    .is('ended_at', null)
  if (!sessions || sessions.length === 0) return { ok: true, ended: 0 }

  let ended = 0
  for (const s of sessions) {
    const out = await endSession(db, s.id, { nowMs })
    if (out.ok && !out.alreadyEnded) ended++
  }
  return { ok: true, ended }
}
