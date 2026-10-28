// UN1TWRITE.14 — the shared gate and answer mapping for the staff un1t.online
// class routes (/api/un1t-online/classes, …/book, …/cancel, UN1TMOVE.1's
// …/move) and UN1TCOMP.1's /api/un1t-online/credits/comp.
//
// Access is judged on the BOOKING studio (the un1t.online studio the class
// runs at), never on the contact's home studio: a Stillorgan contact can be
// booked into a Hatch class by a Hatch member of staff, and a Stillorgan-only
// member of staff cannot book anyone at Hatch. The contact must be in that
// studio's organisation (404 otherwise, never a confirmation across tenants)
// and hold a un1t.online account there (a un1t_clients row for its
// un1t_user_id at the studio).

import { assertLocationAccess } from './auth.js'
import { readUn1tWriteSettings, Un1tSettingsReadError } from './un1t-online-settings.js'
import { UN1T_WRITE_CODES } from './un1t-online-write.js'
import { UN1T_STAFF_COPY } from './un1t-staff-booking-copy.js'

const C = UN1T_WRITE_CODES
// moveBooking's code for a done move on the ledger the check read could not
// confirm (UN1T_MOVE_CODES.PRIOR_MOVE_UNVERIFIED; named here so this module,
// which the routes share, does not import the write ops).
const MOVE_UNVERIFIED = 'move_unverified'
// UN1TMOVE.2 — the late-window rule's codes (UN1T_LATE_MOVE_CODES), in staff words.
const LATE_RULE_COPY = Object.freeze({
  move_late_other_day: UN1T_STAFF_COPY.moveLateOtherDay,
  cancel_after_late_move: UN1T_STAFF_COPY.cancelAfterLateMove,
  move_window_unreadable: UN1T_STAFF_COPY.lateCheckUnreadable,
  cancel_late_move_unreadable: UN1T_STAFF_COPY.lateCheckUnreadable,
})
const REFUSED_TEXT = Object.freeze({
  book: 'un1t.online refused the booking.',
  cancel: 'un1t.online refused the cancellation.',
  move: 'un1t.online refused the move.',
  comp: UN1T_STAFF_COPY.compRefused,
})

export { UN1T_STAFF_COPY }

/**
 * @returns {Promise<{ ok: true, contact: object, un1tUserId: string, studioName: string }
 *   | { ok: false, status: 400|401|403|404|503, error: string }>}
 */
export async function gateUn1tStaffBooking(db, user, { locationId, contactId, offText = UN1T_STAFF_COPY.off }) {
  if (!user) return { ok: false, status: 401, error: 'Unauthorised' }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return { ok: false, status: guard.status, error: 'You do not have access to this studio.' }

  let s
  try {
    s = await readUn1tWriteSettings(db, locationId)
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return { ok: false, status: 503, error: UN1T_STAFF_COPY.settingsUnreadable }
    throw err
  }
  const studioName = s.studioName || 'this studio'
  if (s.membershipSource !== 'un1t_online' || !s.settings.writesEnabled) {
    return { ok: false, status: 400, error: offText(studioName) }
  }

  // `id` is the primary key.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, organization_id, name, un1t_user_id')
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr) return { ok: false, status: 503, error: 'Could not read the contact just now. Try again.' }
  if (!contact || !contact.organization_id || contact.organization_id !== s.organizationId) {
    return { ok: false, status: 404, error: 'Contact not found' }
  }
  const un1tUserId = typeof contact.un1t_user_id === 'string' && contact.un1t_user_id.trim() ? contact.un1t_user_id.trim() : null
  if (!un1tUserId) return { ok: false, status: 400, error: UN1T_STAFF_COPY.noAccount(studioName) }
  const { data: client, error: clientErr } = await db
    .from('un1t_clients')
    .select('id')
    .eq('location_id', locationId)
    .eq('un1t_user_id', un1tUserId)
    .limit(1)
    .maybeSingle()
  if (clientErr) return { ok: false, status: 503, error: 'Could not read the un1t.online account just now. Try again.' }
  if (!client) return { ok: false, status: 400, error: UN1T_STAFF_COPY.noAccount(studioName) }

  return { ok: true, contact, un1tUserId, studioName }
}

/**
 * A book, cancel, move or (UN1TCOMP.1) comp credits result as the route's answer.
 * done → 200; budget spent → 429; a permission missing, an attempt in flight
 * or any refusal → 409 with un1t.online's (scrubbed) words; unknown → 502
 * with the unknown copy (or the unconfirmed-already-booked copy).
 * @returns {{ status: number, body: object }}
 */
export function staffWriteAnswer(r, { op }) {
  if (r.verdict === 'done') {
    if (op === 'comp') {
      // UN1TCOMP.1: the batch un1t.online made; its expiry is what staff see.
      const d = r.data && typeof r.data === 'object' ? r.data : {}
      return {
        status: 200,
        body: { success: true, data: { batch_id: r.id ?? null, expires_at: d.expires_at ?? null, recovered: r.recovered ?? null, ledger_id: r.ledgerId ?? null } },
      }
    }
    const data = op === 'book'
      ? { un1t_booking_id: r.id ?? null, already_booked: r.alreadyBooked === true, message: r.alreadyBooked ? UN1T_STAFF_COPY.alreadyBooked : null }
      : { un1t_booking_id: r.id ?? null }
    return { status: 200, body: { success: true, data: { ...data, ledger_id: r.ledgerId ?? null } } }
  }
  if (r.verdict === 'unknown') {
    const error = r.code === C.ALREADY_BOOKED_UNVERIFIED
      ? UN1T_STAFF_COPY.alreadyBookedUnverified
      : r.code === MOVE_UNVERIFIED
        ? UN1T_STAFF_COPY.moveUnverified
        : op === 'comp'
          ? UN1T_STAFF_COPY.compUnknown
          : r.code === C.BOOKING_NOT_THIS_CLIENT && r.message ? r.message : UN1T_STAFF_COPY.unknown
    return { status: 502, body: { success: false, code: r.code ?? 'outcome_unknown', error, ledger_id: r.ledgerId ?? null } }
  }
  if (r.code === C.RATE_BUDGET || r.code === C.RATE_LIMITED) {
    return { status: 429, body: { success: false, code: r.code, error: UN1T_STAFF_COPY.busy } }
  }
  const error = LATE_RULE_COPY[r.code] || r.message || REFUSED_TEXT[op] || REFUSED_TEXT.cancel
  return { status: 409, body: { success: false, code: r.code ?? null, error, ledger_id: r.ledgerId ?? null } }
}
