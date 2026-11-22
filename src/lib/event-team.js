// EVENTTEAM.1 + TEAMNAMES.1 — the one place an event signup picks its team row.
//
// A team row belongs to ONE event (TEAMNAMES.1, mig 870: `teams.race_event_id`,
// unique on (race_event_id, name)). So a returning captain books "Rockets" at
// every event under that name: each event gets its own "Rockets" row and its
// own roster (`team_members` belongs to the row), and no event's entry can
// rewrite another's.
//
// Rows from before mig 870 that were entered at more than one event (or at
// none) keep `race_event_id` NULL and stay unique on (location_id, name). Such
// a legacy row still holds its name at an event it is ENTERED at, so it is read
// too: a typed name never makes a second team of that name at one event.
//
// Within an event a name is never enough to take over a row: a found row is
// reused only when it is ALREADY this captain's team. Anything else (another
// captain, or no captain on record) gets a fresh row under the next free
// suffixed name ("Name 2", "Name 3", …), the same rule the solo "find me a
// team" entries use. This helper never writes to a found row: the caller
// updates a reused row's size only once it knows it is going ahead.
//
// A failed read is a refusal, never a guess.

export const EVENT_TEAM_NAME_TRIES = 20

/**
 * The team row holding `name` at this event, if any: the event's own row, else
 * a legacy (event-less) row of that name that is entered at this event.
 * @param {import('@/lib/supabase').Db} db
 * @param {{ locationId: string, raceEventId: string, name: string }} args
 * @returns {Promise<{ ok: true, row: { id: string, captain_contact_id: string|null }|null } | { ok: false, message: string }>}
 */
async function findTeamAtEvent(db, { locationId, raceEventId, name }) {
  const { data: own, error: ownErr } = await db
    .from('teams')
    .select('id, captain_contact_id')
    .eq('location_id', locationId)
    .eq('race_event_id', raceEventId)
    .eq('name', name)
    .maybeSingle()
  if (ownErr) return { ok: false, message: ownErr.message }
  if (own) return { ok: true, row: own }

  const { data: legacy, error: legacyErr } = await db
    .from('teams')
    .select('id, captain_contact_id')
    .eq('location_id', locationId)
    .is('race_event_id', null)
    .eq('name', name)
    .maybeSingle()
  if (legacyErr) return { ok: false, message: legacyErr.message }
  if (!legacy) return { ok: true, row: null }

  const { data: here, error: hereErr } = await db
    .from('race_registrations')
    .select('id')
    .eq('team_id', legacy.id)
    .eq('race_event_id', raceEventId)
    .limit(1)
  if (hereErr) return { ok: false, message: hereErr.message }
  return { ok: true, row: here && here.length > 0 ? legacy : null }
}

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {{ locationId: string, raceEventId: string, name: string, size: number,
 *   captainContactId?: string|null, maxTries?: number }} args
 * @returns {Promise<
 *   | { ok: true, teamId: string, teamName: string, reused: boolean }
 *   | { ok: false, reason: 'read_failed' | 'insert_failed' | 'no_free_name', message?: string }
 * >}
 */
export async function resolveEventTeam(db, {
  locationId,
  raceEventId,
  name,
  size,
  captainContactId,
  maxTries = EVENT_TEAM_NAME_TRIES,
}) {
  const baseName = String(name || '').trim()
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const candidate = attempt === 1 ? baseName : `${baseName} ${attempt}`
    const found = await findTeamAtEvent(db, { locationId, raceEventId, name: candidate })
    if (!found.ok) return { ok: false, reason: 'read_failed', message: found.message }

    if (found.row) {
      const ownTeam = !!captainContactId && found.row.captain_contact_id === captainContactId
      if (!ownTeam) continue
      return { ok: true, teamId: found.row.id, teamName: candidate, reused: true }
    }

    const { data: inserted, error: insErr } = await db
      .from('teams')
      .insert({
        location_id: locationId,
        race_event_id: raceEventId,
        name: candidate,
        size,
        captain_contact_id: captainContactId || null,
      })
      .select('id')
      .single()
    if (insErr) {
      // Taken at this event between the read and the insert: try the next name.
      if (insErr.code === '23505') continue
      return { ok: false, reason: 'insert_failed', message: insErr.message }
    }
    return { ok: true, teamId: inserted.id, teamName: candidate, reused: false }
  }
  return { ok: false, reason: 'no_free_name' }
}
