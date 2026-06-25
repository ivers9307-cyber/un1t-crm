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
 */
export async function registrationPaidCents(db, registrationId) {
  const { data } = await db.from('race_payments')
    .select('amount_cents, status')
    .eq('race_registration_id', registrationId)
    .limit(10)
  return (data || [])
    .filter((p) => String(p.status || '').toLowerCase() === 'completed')
    .reduce((sum, p) => sum + (Number(p.amount_cents) || 0), 0)
}

/**
 * Cancel a registration. Idempotent: cancelling a cancelled row is ok.
 * @returns { ok, alreadyCancelled?, error? }
 */
export async function cancelRaceRegistration(db, registrationId) {
  const { data: reg, error: readErr } = await db.from('race_registrations')
    .select('id, status')
    .eq('id', registrationId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!reg) return { ok: false, error: 'not_found' }
  if (reg.status === 'cancelled') return { ok: true, alreadyCancelled: true }

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
  const { data: reg } = await db.from('race_registrations')
    .select('id, race_event_id, status, wave_id')
    .eq('id', registrationId)
    .maybeSingle()
  if (!reg) return { ok: false, error: 'not_found' }
  if (reg.status === 'cancelled' || reg.status === 'no_show') return { ok: false, error: 'not_active' }
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
