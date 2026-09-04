// Race-control helpers (mig 081). Pure functions where possible so the
// race-UI logic is testable without standing up real Supabase. The one
// IO function — ensureTeamForBooking — is documented carefully because
// it's load-bearing for the auto-team-on-first-race-start path: any
// timed-event booking that somehow landed without a team_id (race UI
// opened on a booking created before mig 081, or via a non-widget
// channel) gets a team auto-created so the operator never sees an
// "unteamed" row.

import { logWarn } from './log'

// SHARED-CORE: the pure timing helpers (formatElapsed / classifyBookingState
// / elapsedSecondsBetween / penaltySumSeconds / elapsedWithPenalties) moved
// to shared/race-control.js so the mobile race-day control screen imports the
// exact same source. Re-exported here so every web caller — and
// race-control.test.js — keeps importing them from '@/lib/race-control'
// unchanged. The IO helper ensureTeamForBooking stays web-only below.
//
// RACEDAY.1 added the wave/participant/layout helpers below the timing ones.
// EVERY pure export of shared/race-control.js must be listed here: web
// callers import from '@/lib/race-control', so a shared export missing from
// this list resolves to `undefined` at the call site with no build error, and
// tests/shared-pair-sync.test.js holds this pair in mode `reexport` (runtime
// identity), which fails if the two surfaces drift.
export {
  formatElapsed,
  classifyBookingState,
  elapsedSecondsBetween,
  penaltySumSeconds,
  elapsedWithPenalties,
  waveDisplayLabel,
  waveSortKey,
  participantNames,
  shouldShowParticipants,
  portraitPanelFlex,
} from '../../shared/race-control'

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
