// Membership pause window capture (GLOFOX-REACTIVE).
//
// Empirically, Glofox delivers a subscription pause as a
// MEMBERSHIP_UPDATED event with Payload.status='PAUSED' and the resume
// date in Payload.cycle.start_date — it does NOT emit a SERVICE_*
// event for membership pauses (verified across multiple live pauses
// with the service webhook enabled). The published spec's
// ServiceEvent.pause is for a different "service" concept.
//
// So the resume date comes from the membership event's cycle. The pause
// *status* is still owned by the member sync (glofox_membership_state);
// this module only writes the denormalised window columns
// (glofox_membership_paused_at / _resume_at) on contacts.

function toIso(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Parse a Glofox MembershipEvent payload's pause window.
 * Handles capital `Payload` (real events) and lowercase `payload`.
 * Returns { status, paused, resume_at, paused_at } or null.
 */
export function parseMembershipPause(rawEventOrPayload) {
  if (!rawEventOrPayload || typeof rawEventOrPayload !== 'object') return null
  const p =
    (rawEventOrPayload.Payload && typeof rawEventOrPayload.Payload === 'object' && rawEventOrPayload.Payload) ||
    (rawEventOrPayload.payload && typeof rawEventOrPayload.payload === 'object' && rawEventOrPayload.payload) ||
    rawEventOrPayload
  const status = typeof p.status === 'string' ? p.status.trim().toUpperCase() : null
  const paused = status === 'PAUSED'
  const cycle = p.cycle && typeof p.cycle === 'object' ? p.cycle : {}
  // For a paused membership the next cycle begins on the resume date —
  // cycle.start_date. Fall back to next_payment_date if absent.
  const resumeAt = paused ? (toIso(cycle.start_date) || toIso(cycle.next_payment_date)) : null
  // No explicit "pause start" field; modified ~= when the pause was
  // applied. Fall back to created.
  const pausedAt = paused ? (toIso(p.modified) || toIso(p.created)) : null
  return { status, paused, resume_at: resumeAt, paused_at: pausedAt }
}

/**
 * Denormalise the pause window onto the contact from a MEMBERSHIP_*
 * event. Does NOT touch glofox_membership_state (the member sync owns
 * that). Best-effort — returns a structured result, never throws.
 *
 * Multi-membership guard: a member can hold several memberships (e.g. a
 * PAYG + a paused subscription). We only CLEAR the window on a
 * non-paused event when the contact isn't paused overall, so an active
 * membership's event can't wipe another membership's live pause.
 */
export async function applyMembershipPauseWindow(db, contactId, rawEvent) {
  const mp = parseMembershipPause(rawEvent)
  if (!mp || !contactId) return { ok: false, reason: 'unparseable_or_no_contact' }

  if (mp.paused) {
    const { error } = await db
      .from('contacts')
      .update({
        glofox_membership_paused_at: mp.paused_at,
        glofox_membership_resume_at: mp.resume_at,
      })
      .eq('id', contactId)
    if (error) return { ok: false, reason: 'update_failed', error: error.message }
    return { ok: true, paused: true, resume_at: mp.resume_at }
  }

  // Non-paused event: only clear the window if the member isn't paused
  // overall (another membership may still be on a live freeze).
  let currentState = null
  try {
    const { data } = await db
      .from('contacts')
      .select('glofox_membership_state')
      .eq('id', contactId)
      .maybeSingle()
    currentState = data?.glofox_membership_state ?? null
  } catch {
    // treat as unknown; fall through to the guard below
  }
  if (currentState === 'paused') {
    return { ok: true, paused: false, cleared: false }
  }
  const { error } = await db
    .from('contacts')
    .update({
      glofox_membership_paused_at: null,
      glofox_membership_resume_at: null,
    })
    .eq('id', contactId)
  if (error) return { ok: false, reason: 'clear_failed', error: error.message }
  return { ok: true, paused: false, cleared: true }
}
