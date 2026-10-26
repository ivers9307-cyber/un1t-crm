// USAGE.1 — recording one app usage batch (POST /api/usage/events).
//
// The batch comes from shared/usage-tracker.js on a staff phone or browser,
// timed by the device clock. Nothing here trusts that clock: times are
// clamped to a window around the server's now, a visit is trimmed into its
// session and capped at 4 h, and a batch whose session ended more than 48 h
// ago is dropped (a phone that was off for a weekend posting a stale queue).
// Clamped rows are kept, not refused: a skewed clock costs accuracy, never
// the record.
//
// Ids are the client's, so a re-sent batch upserts the same rows. A session
// id that already belongs to another profile is refused outright, so one
// person can never overwrite another's record.

export const FUTURE_SLACK_MS = 2 * 60_000
export const MAX_AGE_MS = 48 * 3600_000
export const MAX_VISIT_MS = 4 * 3600_000

const iso = (ms) => new Date(ms).toISOString()

/**
 * Who is recorded: an ordinary signed-in staff member. Never a master, a
 * master's "view as" session or a support session (the time would be filed
 * against the person being viewed). getCurrentUser already resolves members,
 * tombstones and deactivated staff to null.
 */
export function shouldRecordFor(user) {
  if (!user || !user.id) return false
  if (user.isMaster || user.profileRole === 'master') return false
  if (user.impersonatingFrom || user.supportSession) return false
  return true
}

/**
 * Clamp a validated batch to the server clock. Returns null when nothing
 * worth keeping is left.
 */
export function clampBatch(batch, nowMs) {
  const ceiling = nowMs + FUTURE_SLACK_MS
  const floor = nowMs - MAX_AGE_MS
  const sStart = Date.parse(batch.session.started_at)
  const sEnd = Date.parse(batch.session.ended_at)
  if (!(sEnd >= sStart)) return null
  if (sEnd < floor) return null
  const start = Math.max(sStart, floor)
  const end = Math.min(sEnd, ceiling)
  if (end < start) return null

  const visits = []
  for (const v of batch.visits) {
    const vStart = Math.max(Date.parse(v.started_at), start)
    let vEnd = Math.min(Date.parse(v.ended_at), end)
    vEnd = Math.min(vEnd, vStart + MAX_VISIT_MS)
    if (!(vEnd > vStart)) continue
    visits.push({ ...v, started_at: iso(vStart), ended_at: iso(vEnd) })
  }

  return {
    session: { ...batch.session, started_at: iso(start), ended_at: iso(end) },
    visits,
  }
}

/**
 * Write one batch for `profileId`. Returns { recorded: true, visits } or
 * { recorded: false, reason }. Throws on a database error, so the route
 * answers 503 and the client keeps the batch for its next flush.
 */
export async function recordUsageBatch({ db, profileId, locationId, batch, nowMs }) {
  const clamped = clampBatch(batch, nowMs)
  if (!clamped) return { recorded: false, reason: 'too_old' }
  const { session, visits } = clamped

  const { data: existing, error: readErr } = await db
    .from('app_usage_sessions')
    .select('profile_id, location_id')
    .eq('id', session.id)
    .maybeSingle()
  if (readErr) throw new Error(`usage session read failed: ${readErr.code || readErr.message}`)
  if (existing && existing.profile_id !== profileId) {
    return { recorded: false, reason: 'session_owner_mismatch' }
  }

  const nowIso = iso(nowMs)
  const { error: sessionErr } = await db.from('app_usage_sessions').upsert({
    id: session.id,
    profile_id: profileId,
    // The studio the session STARTED at: a re-send after switching studios
    // keeps the first answer.
    location_id: existing ? existing.location_id : (locationId || null),
    platform: session.platform,
    app_version: session.app_version || null,
    started_at: session.started_at,
    ended_at: session.ended_at,
    updated_at: nowIso,
  }, { onConflict: 'id' })
  if (sessionErr) throw new Error(`usage session write failed: ${sessionErr.code || sessionErr.message}`)

  if (visits.length > 0) {
    const { error: visitErr } = await db.from('app_usage_visits').upsert(
      visits.map((v) => ({
        id: v.id,
        session_id: session.id,
        profile_id: profileId,
        feature: v.feature,
        started_at: v.started_at,
        ended_at: v.ended_at,
      })),
      { onConflict: 'id' },
    )
    if (visitErr) throw new Error(`usage visit write failed: ${visitErr.code || visitErr.message}`)
  }

  return { recorded: true, visits: visits.length }
}
