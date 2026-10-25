// registration-move-history — the two reads behind the "Moved from" chip and
// the "moves to other events" footer (EVENT-MOVE.1). Shared by the staff teams
// route and the host event page (EVENT-MOVE.2). Both reads degrade: a failure
// is logged and costs only the chip or the footer, never the caller's response.
import { entryLabel } from './registration-entry'
import { logError } from './log'

/**
 * The latest move INTO this event per entry (the "Moved from" chip) and every
 * move OUT of it (the footer), both from registration_moves. Decoration only:
 * a failed (or throwing) read costs the chip or the footer, logged, and never
 * the caller's list.
 *
 * @param {object} db  service-role client; the CALLER has already gated the event
 * @param {{ eventId: string, regIds: string[] }} args
 * @returns {Promise<{ lastMoveByReg: Record<string, object>, movedOut: Array<object> }>}
 */
export async function loadMoveHistory(db, { eventId, regIds }) {
  const lastMoveByReg = {}
  let movedOut = []
  if (regIds.length > 0) {
    try {
      const { data: movesIn, error: movesInErr } = await db
        .from('registration_moves')
        .select('id, registration_id, created_at, actor_name, price_gap_cents, forced, notified_at, gap_settled_at, gap_settled_how, gap_settled_by_name, from_event:from_event_id ( id, name, race_date )')
        // Filtered on the event alone: an .in() over every entry id grows the
        // URL with the event and can outrun the request-line limit on a big one.
        // The 1,000-row cap is per event and the read is newest first, so only
        // an event with over 1,000 moves in could lose its OLDEST chips.
        .eq('to_event_id', eventId)
        .order('created_at', { ascending: false })
      if (movesInErr) logError('registration-move-history', 'moves-in read failed; chips omitted', { err: movesInErr, eventId })
      // Newest first, so the first row seen per entry is its latest move in.
      // A move in whose entry has since left this event is not on the list.
      const onList = new Set(regIds)
      for (const m of movesIn || []) {
        if (onList.has(m.registration_id) && !lastMoveByReg[m.registration_id]) lastMoveByReg[m.registration_id] = m
      }
    } catch (err) {
      logError('registration-move-history', 'moves-in read threw; chips omitted', { err, eventId })
    }
  }
  try {
    // The registration embed carries the team the entry sits on NOW (a
    // cross-studio move clones it), which is the right name to show; the
    // contact is there for an entry with no team.
    const { data: movesOut, error: movesOutErr } = await db
      .from('registration_moves')
      .select('id, created_at, actor_name, registration:registration_id ( id, contact:contact_id ( first_name, last_name ), teams:team_id ( name, size, team_members ( name, role ) ) ), to_event:to_event_id ( id, name, race_date )')
      .eq('from_event_id', eventId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (movesOutErr) logError('registration-move-history', 'moves-out read failed; footer omitted', { err: movesOutErr, eventId })
    movedOut = (movesOut || []).map((m) => ({
      id: m.id, created_at: m.created_at, actor_name: m.actor_name,
      label: entryLabel(m.registration || {}),
      to_event: m.to_event || null,
    }))
  } catch (err) {
    logError('registration-move-history', 'moves-out read threw; footer omitted', { err, eventId })
    movedOut = []
  }
  return { lastMoveByReg, movedOut }
}
