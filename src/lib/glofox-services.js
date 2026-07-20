// Glofox SERVICE_* webhook → CRM pause window (GLOFOX-REACTIVE).
//
// A Glofox "service" is a member's purchased membership/pack. Its
// webhook payload is the ONLY Glofox surface that carries the pause
// window — start_date, duration, and crucially resume_date. The
// member GET (/2.0/members/{id}) that the sync uses has only a bare
// subscription.paused boolean, no date. So SERVICE_* is where we
// learn "paused until 15 Aug".
//
// Pipeline per event:
//   1. parseServicePayload(payload)  — extract canonical shape + pause
//   2. upsertGlofoxService(...)      — write source-of-truth row
//   3. applyPauseToContact(...)      — denormalise pause window +
//                                      membership state onto contacts
//
// Idempotency: glofox_services.id (the Glofox service id) is the PK.
// SERVICE_UPDATED for the same service upserts the same row; the
// contact denormalisation is a plain overwrite, so out-of-order or
// retried delivery converges.

function toIso(raw) {
  if (typeof raw !== 'string' || !raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Parse a Glofox ServiceEvent payload into the shape we persist.
 *
 * ServiceEvent uses lowercase `payload` (unlike Invoice/Membership
 * events which capitalise it) — we unwrap either. Returns null when
 * the service id is missing (caller logs + skips rather than throws).
 *
 * @param {object} rawEventOrPayload  the full event OR its payload
 */
export function parseServicePayload(rawEventOrPayload) {
  if (!rawEventOrPayload || typeof rawEventOrPayload !== 'object') return null
  const p =
    (rawEventOrPayload.payload && typeof rawEventOrPayload.payload === 'object' && rawEventOrPayload.payload) ||
    (rawEventOrPayload.Payload && typeof rawEventOrPayload.Payload === 'object' && rawEventOrPayload.Payload) ||
    rawEventOrPayload
  if (!p.id) return null

  // member_ids is an array; the first is the owning member. Matches
  // contacts.glofox_member_id.
  const memberId = Array.isArray(p.member_ids) && p.member_ids.length > 0 ? String(p.member_ids[0]) : null
  const membershipId = p.membership_id != null ? String(p.membership_id) : null
  const status = typeof p.status === 'string' ? p.status.trim().toLowerCase() : null

  // pause is an object when the service is paused, nil otherwise.
  const pauseObj = p.pause && typeof p.pause === 'object' ? p.pause : null
  const paused = !!pauseObj
  const pauseStartAt = pauseObj ? toIso(pauseObj.start_date) : null
  const pauseResumeAt = pauseObj ? toIso(pauseObj.resume_date) : null
  const durationUnit = pauseObj && typeof pauseObj.duration_unit === 'string'
    ? pauseObj.duration_unit.trim().toUpperCase()
    : null
  const durationAmount = pauseObj && Number.isFinite(pauseObj.duration_amount)
    ? Math.round(pauseObj.duration_amount)
    : null

  return {
    id: String(p.id),
    glofox_user_id: memberId,
    membership_id: membershipId,
    status,
    paused,
    pause_start_at: pauseStartAt,
    pause_resume_at: pauseResumeAt,
    pause_duration_unit: durationUnit,
    pause_duration_amount: durationAmount,
    next_payment_at: toIso(p.next_payment_date),
  }
}

/**
 * Upsert a parsed service into glofox_services, keeping the raw event
 * for forensics. Returns { ok, row, error }.
 */
export async function upsertGlofoxService(db, locationId, contactId, parsed, rawEvent) {
  if (!db || !parsed?.id) return { ok: false, error: 'missing args' }
  const row = {
    id: parsed.id,
    contact_id: contactId,
    location_id: locationId,
    membership_id: parsed.membership_id,
    glofox_user_id: parsed.glofox_user_id,
    status: parsed.status,
    paused: parsed.paused,
    pause_start_at: parsed.pause_start_at,
    pause_resume_at: parsed.pause_resume_at,
    pause_duration_unit: parsed.pause_duration_unit,
    pause_duration_amount: parsed.pause_duration_amount,
    next_payment_at: parsed.next_payment_at,
    raw_payload: rawEvent,
    updated_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
  }
  const { data, error } = await db
    .from('glofox_services')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: data }
}

/**
 * Denormalise the pause window + membership state onto the contact.
 *
 *   paused  → glofox_membership_state='paused' + pause columns set.
 *   resumed → pause columns cleared; state flipped back to 'active'
 *             ONLY if it was 'paused' (never stomp cancelled/expired/
 *             locked — the authoritative lifecycle comes from the
 *             member sync).
 *
 * Returns { stateChange: {from,to} | null } so the caller can fire
 * the membership_state_change sequence trigger on a real flip.
 */
export async function applyPauseToContact(db, contactId, parsed) {
  if (!db || !contactId) return { stateChange: null }

  // Read current state so we can (a) detect a real flip and (b) avoid
  // stomping a non-paused lifecycle state on resume.
  let currentState = null
  try {
    const { data } = await db
      .from('contacts')
      .select('glofox_membership_state')
      .eq('id', contactId)
      .single()
    currentState = data?.glofox_membership_state ?? null
  } catch {
    // fall through with null — treated as "unknown", safe either way
  }

  let updates
  let toState
  if (parsed.paused) {
    toState = 'paused'
    updates = {
      glofox_membership_state: 'paused',
      glofox_membership_paused_at: parsed.pause_start_at,
      glofox_membership_resume_at: parsed.pause_resume_at,
    }
  } else {
    // Resumed / never-paused: clear the window. Only move state off
    // 'paused'; leave any other lifecycle state untouched.
    toState = currentState === 'paused' ? 'active' : currentState
    updates = {
      glofox_membership_paused_at: null,
      glofox_membership_resume_at: null,
    }
    if (currentState === 'paused') updates.glofox_membership_state = 'active'
  }

  const { error } = await db.from('contacts').update(updates).eq('id', contactId)
  if (error) return { stateChange: null, error: error.message }

  const stateChange = currentState !== toState ? { from: currentState, to: toState } : null
  return { stateChange }
}

/**
 * One-shot orchestration for the webhook receiver — parse, upsert the
 * service row, denormalise the pause window onto the contact.
 * Returns a structured result for the audit log.
 */
export async function applyServiceWebhook(db, locationId, contactId, rawEvent) {
  const parsed = parseServicePayload(rawEvent)
  if (!parsed) return { ok: false, reason: 'unparseable_service' }
  if (!contactId) return { ok: false, reason: 'no_contact', parsed }
  const upsert = await upsertGlofoxService(db, locationId, contactId, parsed, rawEvent)
  if (!upsert.ok) return { ok: false, reason: 'service_write_failed', error: upsert.error, parsed }
  const applied = await applyPauseToContact(db, contactId, parsed)
  return {
    ok: true,
    service_id: parsed.id,
    paused: parsed.paused,
    resume_at: parsed.pause_resume_at,
    state_change: applied.stateChange,
  }
}
