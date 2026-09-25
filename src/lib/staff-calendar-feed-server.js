// src/lib/staff-calendar-feed-server.js
// ICSFEED.1 — the calendar feed's database work. Service-role client only
// (the table has no browser grants, mig 632).
//
// SCOPE: every read here is pinned to ONE profile — the one the token
// resolves to (the feed) or the session's own id (management). There is no id
// parameter anywhere a caller controls. That is the tenant boundary: a person's
// own shifts, at whichever studios they are rostered, and nobody else's rows.
// Deliberately NOT organisation-scoped: someone rostered in two organisations
// sees both in their own calendar. It is their diary, not a tenant's report,
// and no other person's row is ever read, so no tenant data crosses over.
//
// DEACTIVATION (D5): resolveCalendarFeed refuses a profile with active=false
// or deleted_at set. That one check covers PUT active:false, DELETE
// /api/staff/[id], the tombstone and a hand-run SQL flip; no deactivation path
// needs to know this table exists (the widget-auth ACTIVEUSER.1 lock).

import { generateCalendarFeedToken, hashCalendarFeedToken } from '@/lib/calendar-feed-token'
import { isTombstone } from '@/lib/staff-tombstone'
import { logError, logWarn } from '@/lib/log'

/** Own assignment + its block. No colleague, no note, no pay (see the pure module's header). */
export const FEED_SHIFT_SELECT = `
  id, status, start_time_override, end_time_override, updated_at,
  shift_blocks!inner (
    location_id, block_date, start_time, end_time, updated_at,
    rosters:roster_id ( status ),
    shift_templates ( name )
  )
`

/** D8 — per TOKEN, never per IP (Google fetches every feed from shared egress; UNSUB-RL.1). */
export const FEED_TOKEN_RL = Object.freeze({ max: 30, windowMs: 15 * 60_000 })

/** D10 — last_fetched_at is stamped at most this often. */
export const TOUCH_INTERVAL_MS = 15 * 60_000

// PostgREST's silent per-select cap. One person over 70 days is ~200 rows at
// most; hitting the cap would mean something is badly wrong, so say so.
const POSTGREST_ROW_CAP = 1000

/**
 * @returns {Promise<{status:'ok', feed:{profile_id:string,last_fetched_at:string|null}, tokenHash:string}
 *   | {status:'unknown'} | {status:'inactive'} | {status:'error'}>}
 */
export async function resolveCalendarFeed(db, token) {
  const tokenHash = hashCalendarFeedToken(token)
  if (!tokenHash) return { status: 'unknown' }

  const { data: feed, error } = await db
    .from('staff_calendar_feeds')
    .select('profile_id, last_fetched_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (error) {
    logError('calendar-feed', 'token lookup failed', { err: error })
    return { status: 'error' }
  }
  if (!feed) return { status: 'unknown' }

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, active, deleted_at')
    .eq('id', feed.profile_id)
    .maybeSingle()
  if (profileError) {
    logError('calendar-feed', 'profile read failed', { err: profileError })
    return { status: 'error' }
  }
  // Strictly `=== false`, as in getCurrentUser: a missing `active` never locks
  // anyone out. A tombstone is always active=false too (mig 622 CHECK); both
  // tests are kept, as widget-auth keeps them.
  if (!profile || isTombstone(profile) || profile.active === false) return { status: 'inactive' }

  return { status: 'ok', feed, tokenHash }
}

/** The person's own assignments in the window, plus the studios they sit at. */
export async function loadFeedShifts(db, profileId, { from, to }) {
  const { data, error } = await db
    .from('shift_assignments')
    .select(FEED_SHIFT_SELECT)
    .eq('profile_id', profileId)
    .gte('shift_blocks.block_date', from)
    .lte('shift_blocks.block_date', to)
    .order('id')
  if (error) {
    logError('calendar-feed', 'shift read failed', { err: error })
    return { rows: [], locationsById: {}, error }
  }
  const rows = data || []
  if (rows.length >= POSTGREST_ROW_CAP) {
    logWarn('calendar-feed', 'shift read hit the row cap; the feed may be missing shifts', { rows: rows.length })
  }

  const ids = [...new Set(rows.map((r) => r.shift_blocks?.location_id).filter(Boolean))]
  if (ids.length === 0) return { rows, locationsById: {}, error: null }

  const { data: locs, error: locError } = await db
    .from('locations')
    .select('id, name, address, timezone')
    .in('id', ids)
  if (locError) {
    logError('calendar-feed', 'studio read failed', { err: locError })
    return { rows: [], locationsById: {}, error: locError }
  }
  return { rows, locationsById: Object.fromEntries((locs || []).map((l) => [l.id, l])), error: null }
}

/**
 * D10 — stamp last_fetched_at when older than 15 minutes. Never throws, never
 * fails the feed.
 *
 * Pinned by the fetched link's HASH as well as the person: a poll on the OLD
 * token that resolved just before a rotation must not mark the NEW link as
 * "checked by your calendar" (the new row has a different hash, so the
 * UPDATE matches nothing, which is the truth). No hash, no stamp.
 */
export async function touchFeedFetched(db, feed, nowMs, tokenHash) {
  if (!tokenHash || !feed?.profile_id) return
  const last = Date.parse(feed?.last_fetched_at ?? '')
  if (Number.isFinite(last) && nowMs - last < TOUCH_INTERVAL_MS) return
  try {
    const { error } = await db
      .from('staff_calendar_feeds')
      .update({ last_fetched_at: new Date(nowMs).toISOString() })
      .eq('profile_id', feed.profile_id)
      .eq('token_hash', tokenHash)
    if (error) logWarn('calendar-feed', 'last_fetched_at stamp failed', { err: error })
  } catch (e) {
    logWarn('calendar-feed', 'last_fetched_at stamp threw', { err: e })
  }
}

/** { active, created_at, rotated_at, last_fetched_at } for the caller. Never the hash. */
export async function getCalendarFeedStatus(db, profileId) {
  const { data, error } = await db
    .from('staff_calendar_feeds')
    .select('created_at, rotated_at, last_fetched_at')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) return { data: null, error }
  return {
    data: {
      active: !!data,
      created_at: data?.created_at ?? null,
      rotated_at: data?.rotated_at ?? null,
      last_fetched_at: data?.last_fetched_at ?? null,
    },
    error: null,
  }
}

/**
 * Make a link. With replace, the existing row's hash is swapped in ONE UPDATE
 * (the old link dies in the same statement). Without it, an existing link is a
 * conflict (D11), decided by the primary key, so two racing creates cannot both win.
 *
 * @returns {Promise<{token:string, replaced:boolean} | {conflict:true} | {error:object}>}
 */
export async function issueCalendarFeed(db, profileId, { replace = false, nowMs = Date.now() } = {}) {
  const token = generateCalendarFeedToken()
  const tokenHash = hashCalendarFeedToken(token)

  if (replace) {
    const { data, error } = await db
      .from('staff_calendar_feeds')
      .update({ token_hash: tokenHash, rotated_at: new Date(nowMs).toISOString(), last_fetched_at: null })
      .eq('profile_id', profileId)
      .select('profile_id')
    if (error) return { error }
    if ((data || []).length > 0) return { token, replaced: true }
    // Nothing to replace (turned off elsewhere in the meantime): create one.
  }

  const { error } = await db
    .from('staff_calendar_feeds')
    .insert({ profile_id: profileId, token_hash: tokenHash })
  if (error) {
    if (error.code === '23505') return { conflict: true }
    return { error }
  }
  return { token, replaced: false }
}

/** Turn the caller's link off. `revoked` says whether there was one. */
export async function revokeCalendarFeed(db, profileId) {
  const { data, error } = await db
    .from('staff_calendar_feeds')
    .delete()
    .eq('profile_id', profileId)
    .select('profile_id')
  if (error) return { revoked: false, error }
  return { revoked: (data || []).length > 0, error: null }
}
