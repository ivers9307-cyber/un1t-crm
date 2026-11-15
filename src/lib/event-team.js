// EVENTTEAM.1 — the one place an event signup picks its team row.
//
// `teams` is unique on (location_id, name) and a team's roster
// (`team_members`) belongs to the team row, not to a registration. So a name
// that is merely typed into a form can never be enough to take over an
// existing row: doing so rewrote another captain's size, captain and roster,
// and reusing one row at a second event rewrote the first event's roster.
//
// A found row is reused only when it is ALREADY this captain's team and it
// has no registration at any other event. Anything else (another captain, no
// captain on record, or entries at another event) gets a fresh row under the
// next free suffixed name ("Name 2", "Name 3", …), the same rule the solo
// "find me a team" entries use. This helper never writes to a found row: the
// caller updates a reused row's size only once it knows it is going ahead.
//
// A failed read is a refusal, never a guess.

export const EVENT_TEAM_NAME_TRIES = 20

/**
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
    const { data: found, error: findErr } = await db
      .from('teams')
      .select('id, captain_contact_id')
      .eq('location_id', locationId)
      .eq('name', candidate)
      .maybeSingle()
    if (findErr) return { ok: false, reason: 'read_failed', message: findErr.message }

    if (found) {
      const ownTeam = !!captainContactId && found.captain_contact_id === captainContactId
      if (!ownTeam) continue
      const { data: elsewhere, error: elseErr } = await db
        .from('race_registrations')
        .select('id')
        .eq('team_id', found.id)
        .neq('race_event_id', raceEventId)
        .limit(1)
      if (elseErr) return { ok: false, reason: 'read_failed', message: elseErr.message }
      if (elsewhere && elsewhere.length > 0) continue
      return { ok: true, teamId: found.id, teamName: candidate, reused: true }
    }

    const { data: inserted, error: insErr } = await db
      .from('teams')
      .insert({ location_id: locationId, name: candidate, size, captain_contact_id: captainContactId || null })
      .select('id')
      .single()
    if (insErr) {
      // Taken between the read and the insert: try the next name.
      if (insErr.code === '23505') continue
      return { ok: false, reason: 'insert_failed', message: insErr.message }
    }
    return { ok: true, teamId: inserted.id, teamName: candidate, reused: false }
  }
  return { ok: false, reason: 'no_free_name' }
}
