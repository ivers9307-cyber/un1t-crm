// AGENT-EVENTS.3 — race/event registration cancellation + wave move.
// These are the FIRST cancellation primitives for race_registrations
// (nothing in the API flipped status to 'cancelled' before this) —
// built for the customer agent and reusable by any future operator
// UI. Capacity frees implicitly: every wave-capacity count excludes
// cancelled/no_show rows.
//
// Refund policy (Richard, 2026-06-12): refunds are HUMAN-decided per
// case. Nothing here touches money — paid cancellations only reach
// this lib after a human approves them in /approvals, and the refund
// itself (if any) is processed manually in Revolut Business.

/**
 * Total paid cents recorded against a registration. Pure-ish read:
 * sums race_payments rows with status 'completed' (the DB CHECK
 * forbids 'paid'; free + Revolut-completed entries both store 'completed').
 *
 * FINDTEAM.8 (I3) — a placed solo's payment stays on their OWN row, so a team
 * entry that solos were placed into (or that was paired from solos) carries
 * money its own row does not show. Those rows' completed payments are summed
 * in too, so cancelling such a team goes to human review, never a direct
 * cancel. Throws on a failed read: an unknown amount must never read as free.
 */
export async function registrationPaidCents(db, registrationId) {
  const { data: placed, error: placedErr } = await db.from('race_registrations')
    .select('id')
    .eq('placed_into_registration_id', registrationId)
    .limit(50)
  if (placedErr) throw new Error(`placed-into read failed: ${placedErr.message}`)
  const ids = [registrationId, ...(placed || []).map((r) => r.id).filter(Boolean)]
  const { data, error } = await db.from('race_payments')
    .select('amount_cents, status')
    .in('race_registration_id', ids)
    .limit(200)
  if (error) throw new Error(`race_payments read failed: ${error.message}`)
  return (data || [])
    .filter((p) => String(p.status || '').toLowerCase() === 'completed')
    .reduce((sum, p) => sum + (Number(p.amount_cents) || 0), 0)
}

/**
 * FINDTEAM.9 — how many solo rows point at this registration through
 * placed_into_registration_id. A team entry that solos were placed into
 * carries their placements (and, through registrationPaidCents, their
 * payments), so cancelling or deleting it would strand them.
 * @returns {Promise<{ count: number } | { error: string }>}
 */
export async function countPlacedInto(db, registrationId) {
  const { count, error } = await db.from('race_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('placed_into_registration_id', registrationId)
  if (error) return { error: error.message }
  return { count: count || 0 }
}

/**
 * The 409 body every route answers when solos point at the team entry the
 * caller wants gone: the registration DELETE, the operator cancel. One shape,
 * so the Teams page and the approvals surface read it the same way.
 * @param {number} n  placed rows pointing at the team
 * @param {string} verb  'deleted' | 'cancelled'
 */
export function placedSolosRefusal(n, verb) {
  return {
    success: false,
    error: 'has_placed_solos',
    message: `${n} placed ${n === 1 ? 'entrant points' : 'entrants point'} at this team; un-place them first. There is no un-place tool in the CRM yet, so this team cannot be ${verb} from here.`,
    placed_count: n,
  }
}

/**
 * Cancel a registration. Idempotent: cancelling a cancelled row is ok.
 * @returns { ok, alreadyCancelled?, error?, placedCount? }
 *   error 'not_active' = a placed solo's own row; 'has_placed_solos' = solos
 *   were placed into this team (placedCount says how many).
 */
export async function cancelRaceRegistration(db, registrationId) {
  const { data: reg, error: readErr } = await db.from('race_registrations')
    .select('id, status')
    .eq('id', registrationId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!reg) return { ok: false, error: 'not_found' }
  if (reg.status === 'cancelled') return { ok: true, alreadyCancelled: true }
  // FINDTEAM.8 (I3) — a placed solo's row is history (they race with the team
  // they joined, and it carries their payment): never cancelled from here.
  if (reg.status === 'placed') return { ok: false, error: 'not_active' }
  // FINDTEAM.9 — nor is a team entry that solos were placed into: their rows
  // point at it and their payments ride on it. Mia's cancel and the approvals
  // route come through here too, so they inherit the refusal. A failed count
  // refuses as well: an unknown answer must never cancel.
  const placed = await countPlacedInto(db, registrationId)
  if (placed.error) return { ok: false, error: placed.error }
  if (placed.count > 0) return { ok: false, error: 'has_placed_solos', placedCount: placed.count }

  const { error } = await db.from('race_registrations')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', registrationId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Move a registration to another wave of the SAME event, capacity
 * permitting. No money implications — wave moves never change price.
 * @returns { ok, error?: 'not_found'|'wrong_event'|'wave_full'|string }
 */
export async function moveRegistrationWave(db, registrationId, newWaveId) {
  const { data: reg, error: readErr } = await db.from('race_registrations')
    .select('id, race_event_id, status, wave_id')
    .eq('id', registrationId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!reg) return { ok: false, error: 'not_found' }
  // FINDTEAM.8 (I3) — a placed solo runs in their team's wave, not their own row's.
  if (reg.status === 'cancelled' || reg.status === 'no_show' || reg.status === 'placed') return { ok: false, error: 'not_active' }
  if (reg.wave_id === newWaveId) return { ok: true, unchanged: true }

  const { data: wave } = await db.from('race_waves')
    .select('id, race_event_id, capacity')
    .eq('id', newWaveId)
    .maybeSingle()
  if (!wave) return { ok: false, error: 'not_found' }
  if (wave.race_event_id !== reg.race_event_id) return { ok: false, error: 'wrong_event' }

  if (wave.capacity != null) {
    const { count } = await db.from('race_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('wave_id', wave.id)
      .not('status', 'in', '("cancelled","no_show")')
    if ((count || 0) >= wave.capacity) return { ok: false, error: 'wave_full' }
  }

  const { error } = await db.from('race_registrations')
    .update({ wave_id: wave.id, updated_at: new Date().toISOString() })
    .eq('id', registrationId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
