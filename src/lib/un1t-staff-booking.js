// UN1TWRITE.14 — the shared gate and answer mapping for the staff un1t.online
// class routes (/api/un1t-online/classes, …/book, …/cancel).
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

const C = UN1T_WRITE_CODES

/** Staff copy (plan D global constraints, verbatim). */
export const UN1T_STAFF_COPY = Object.freeze({
  unknown: 'un1t.online did not answer clearly. Check the class in un1t.online before trying again.',
  noAccount: (studio) => `This contact has no un1t.online account at ${studio}. They can book through the website.`,
  alreadyBooked: 'Already booked in un1t.online',
  off: (studio) => `un1t.online booking is off at ${studio}.`,
  busy: 'un1t.online is busy. Try again in a minute.',
  // An unconfirmed "already booked" (the words said so; the check read could not).
  alreadyBookedUnverified: 'un1t.online said this person is already booked, but the CRM could not confirm it. Check the class in un1t.online before trying again.',
  settingsUnreadable: "Could not read this studio's un1t.online settings just now. Nothing was sent; try again.",
})

/**
 * @returns {Promise<{ ok: true, contact: object, un1tUserId: string, studioName: string }
 *   | { ok: false, status: 400|401|403|404|503, error: string }>}
 */
export async function gateUn1tStaffBooking(db, user, { locationId, contactId }) {
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
    return { ok: false, status: 400, error: UN1T_STAFF_COPY.off(studioName) }
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
 * A book or cancel result as the route's answer.
 * done → 200; budget spent → 429; a permission missing, an attempt in flight
 * or any refusal → 409 with un1t.online's (scrubbed) words; unknown → 502
 * with the unknown copy (or the unconfirmed-already-booked copy).
 * @returns {{ status: number, body: object }}
 */
export function staffWriteAnswer(r, { op }) {
  if (r.verdict === 'done') {
    const data = op === 'book'
      ? { un1t_booking_id: r.id ?? null, already_booked: r.alreadyBooked === true, message: r.alreadyBooked ? UN1T_STAFF_COPY.alreadyBooked : null }
      : { un1t_booking_id: r.id ?? null }
    return { status: 200, body: { success: true, data: { ...data, ledger_id: r.ledgerId ?? null } } }
  }
  if (r.verdict === 'unknown') {
    const error = r.code === C.ALREADY_BOOKED_UNVERIFIED ? UN1T_STAFF_COPY.alreadyBookedUnverified : UN1T_STAFF_COPY.unknown
    return { status: 502, body: { success: false, code: r.code ?? 'outcome_unknown', error, ledger_id: r.ledgerId ?? null } }
  }
  if (r.code === C.RATE_BUDGET || r.code === C.RATE_LIMITED) {
    return { status: 429, body: { success: false, code: r.code, error: UN1T_STAFF_COPY.busy } }
  }
  const error = r.message || (op === 'book' ? 'un1t.online refused the booking.' : 'un1t.online refused the cancellation.')
  return { status: 409, body: { success: false, code: r.code ?? null, error, ledger_id: r.ledgerId ?? null } }
}
