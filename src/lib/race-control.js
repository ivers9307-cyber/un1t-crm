// Race-control helpers (mig 081). Pure functions where possible so the
// race-UI logic is testable without standing up real Supabase. The one
// IO function — ensureTeamForBooking — is documented carefully because
// it's load-bearing for the auto-team-on-first-race-start path: any
// timed-event booking that somehow landed without a team_id (race UI
// opened on a booking created before mig 081, or via a non-widget
// channel) gets a team auto-created so the operator never sees an
// "unteamed" row.

/**
 * Format an elapsed-time number of seconds as HH:MM:SS.
 *
 *    0       -> "00:00"
 *    59      -> "00:59"
 *    60      -> "01:00"
 *    3599    -> "59:59"
 *    3600    -> "1:00:00"
 *    7200    -> "2:00:00"
 *    null    -> "—"
 *
 * No hour component shown for sub-60-min times — keeps the race UI
 * scannable. Hours-and-up shows H:MM:SS with no leading zero on hours
 * (a 25:00:00 race is valid display).
 *
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
import { logWarn } from './log'

export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (hh === 0) return `${pad(mm)}:${pad(ss)}`
  return `${hh}:${pad(mm)}:${pad(ss)}`
}

/**
 * Classify a booking's race state into one of the four buckets the race
 * UI cares about. Pure — derives from booking + status.
 *
 *   'next_up'    — confirmed booking, no race_started_at yet
 *   'on_course'  — race_started_at set, race_finished_at not yet
 *   'completed'  — both timestamps set
 *   'no_show'    — booking status is 'no_show' OR 'cancelled'
 *
 * @param {object} booking
 * @returns {'next_up' | 'on_course' | 'completed' | 'no_show'}
 */
export function classifyBookingState(booking) {
  if (!booking) return 'next_up'
  if (booking.status === 'no_show' || booking.status === 'cancelled') return 'no_show'
  if (booking.race_finished_at) return 'completed'
  if (booking.race_started_at) return 'on_course'
  return 'next_up'
}

/**
 * Compute elapsed seconds between two ISO timestamps. Returns null if
 * either is missing. Negative results clamp to 0 (defensive — would
 * indicate clock skew or a reset-then-start race condition).
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number|null}
 */
export function elapsedSecondsBetween(startIso, endIso) {
  if (!startIso || !endIso) return null
  const ms = Date.parse(endIso) - Date.parse(startIso)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 1000))
}

/**
 * Sum a registration's penalties[] (mig 124). Operator-applied
 * adjustments are stored as one row per penalty so the audit
 * trail is preserved; the UI sums them to a single offset
 * applied to displayed elapsed time.
 *
 * Returns 0 (not null) for missing/empty arrays so the caller
 * can additively combine without null-checking. Coerces non-
 * numeric entries to 0 — defensive against malformed payloads.
 *
 *   penaltySumSeconds(undefined)              -> 0
 *   penaltySumSeconds([])                     -> 0
 *   penaltySumSeconds([{seconds: 30}])        -> 30
 *   penaltySumSeconds([{seconds: 30}, {seconds: -10}]) -> 20
 *
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number}
 */
export function penaltySumSeconds(penalties) {
  if (!Array.isArray(penalties) || penalties.length === 0) return 0
  let total = 0
  for (const p of penalties) {
    const n = Number(p?.seconds)
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * Adjusted elapsed time for a registration: base elapsed +
 * sum(penalties.seconds). Returns null if the base elapsed is
 * unknowable (no start, or no finish for completed view —
 * caller decides which timestamp to pass for endIso). Penalties
 * apply on top of whatever the caller passes; for live "on
 * course" rows pass nowIso as endIso so penalties show even
 * before the team finishes.
 *
 * Negative result clamps to 0 (a -60s credit on a 30s elapsed
 * shouldn't display as -30s; treat as a finish at zero).
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @param {Array<{seconds:number}>|null|undefined} penalties
 * @returns {number|null}
 */
export function elapsedWithPenalties(startIso, endIso, penalties) {
  const base = elapsedSecondsBetween(startIso, endIso)
  if (base == null) return null
  return Math.max(0, base + penaltySumSeconds(penalties))
}

/**
 * Find-or-create a team for the given booking. Used by the race API
 * routes when a timed-event booking lands without a team_id (rare —
 * the booking widget creates the team at signup time, but a booking
 * created before mig 081 or via the non-widget admin path could be
 * unteamed).
 *
 * Lookup key: (location_id, name). Name defaults to booking.customer_name.
 * If the lookup hits an existing team, link the booking to it and
 * return — no new row created. If it misses, create the team with the
 * booking's customer as captain (contact_id) and link.
 *
 * NOT pure — performs DB IO. Tested with a mocked db chain. Caller
 * passes a service-role client; RLS doesn't apply.
 *
 * @param {SupabaseClient} db
 * @param {object} booking  Must include id, location_id, customer_name, contact_id
 * @returns {Promise<{ team: object, created: boolean }>}
 */
export async function ensureTeamForBooking(db, booking) {
  if (!booking?.id || !booking?.location_id || !booking?.customer_name) {
    throw new Error('ensureTeamForBooking: booking missing id, location_id, or customer_name')
  }
  // If already linked, hydrate and return.
  if (booking.team_id) {
    const { data: existing } = await db
      .from('teams')
      .select('*')
      .eq('id', booking.team_id)
      .single()
    if (existing) return { team: existing, created: false }
    // Link is stale (team deleted) — fall through and re-create.
  }

  const teamName = booking.customer_name.trim()

  // Try find by (location, name).
  const { data: found } = await db
    .from('teams')
    .select('*')
    .eq('location_id', booking.location_id)
    .eq('name', teamName)
    .maybeSingle()

  let team = found
  let created = false
  if (!team) {
    const { data: inserted, error: insertErr } = await db
      .from('teams')
      .insert({
        location_id: booking.location_id,
        name: teamName,
        captain_contact_id: booking.contact_id || null,
      })
      .select()
      .single()
    if (insertErr) throw new Error(`Team create failed: ${insertErr.message}`)
    team = inserted
    created = true

    // Auto-add the captain as a team member if we have a contact for them.
    // Best-effort — failure here doesn't block the team create.
    if (booking.contact_id) {
      try {
        await db.from('team_members').insert({
          team_id: team.id,
          contact_id: booking.contact_id,
          name: teamName, // best-known name; can be refined later
          email: booking.customer_email || null,
          role: 'captain',
        })
      } catch (e) {
        logWarn('race-control', 'failed to seed captain team_member', { teamId: team.id, err: e })
      }
    }
  }

  // Link the booking to this team.
  await db.from('bookings').update({ team_id: team.id }).eq('id', booking.id)

  return { team, created }
}
