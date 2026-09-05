// CANCEL-FORM.5 — the Glofox execution step behind an APPROVED membership
// cancellation, run by the PATCH route only when the location has opted in
// (locations.glofox_auto_cancel_memberships). Pure-ish: the only write is the
// best-effort back-fill of contacts.glofox_user_membership_id.
//
// Result codes the card explains (agent-request-why.js):
//   NO_END_DATE         no machine-readable requested_end_date on the row
//   NOT_EXECUTABLE      no Glofox member id / no credentials for the location
//   NO_USER_MEMBERSHIP  Glofox returned no membership instance id
//   <Glofox code>       kept verbatim (e.g. a minimum-term rejection)

import {
  cancelGlofoxMembership,
  resolveUserMembershipId,
  glofoxCancellationReason,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {object} db
 * @param {object} row  agent_membership_requests row (kind 'cancellation')
 * @param {{contact: object|null, creds: object|null}} deps
 * @returns {Promise<{ok:boolean, status?:number, message_code:(string|null), local_planned_end_date:(string|null), user_membership_id?:string|null}>}
 */
export async function executeMembershipCancellation(db, row, { contact, creds }) {
  const details = row?.details || {}
  const localDate = typeof details.requested_end_date === 'string' ? details.requested_end_date.trim() : ''
  if (!ISO_DAY_RE.test(localDate)) {
    return { ok: false, message_code: 'NO_END_DATE', local_planned_end_date: null }
  }
  // PERSON-ACCT.8 — the request may have elected a sibling account.
  const memberId = details.elected_glofox_member_id || contact?.glofox_member_id || null
  if (!memberId || !creds || missingGlofoxCredentialsForLocation(creds).length) {
    return { ok: false, message_code: 'NOT_EXECUTABLE', local_planned_end_date: null }
  }
  let userMembershipId = contact?.glofox_user_membership_id || null
  if (!userMembershipId) {
    userMembershipId = await resolveUserMembershipId(creds, memberId)
    if (!userMembershipId) {
      return { ok: false, message_code: 'NO_USER_MEMBERSHIP', local_planned_end_date: null }
    }
    if (contact?.id) {
      // Best-effort cache for next time; the cancel does not depend on it.
      try {
        const { error } = await db.from('contacts').update({ glofox_user_membership_id: userMembershipId }).eq('id', contact.id).select('id')
        if (error) console.warn(`[cancel-exec] could not store user_membership_id for ${contact.id}: ${error.message}`)
      } catch (e) {
        console.warn(`[cancel-exec] could not store user_membership_id for ${contact.id}: ${e?.message || e}`)
      }
    }
  }
  const result = await cancelGlofoxMembership(creds, {
    userMembershipId,
    memberId,
    localDate,
    reason: glofoxCancellationReason(details.reason_code),
  })
  return {
    ok: result.ok,
    status: result.status,
    message_code: result.message_code ?? null,
    local_planned_end_date: result.local_planned_end_date ?? null,
    user_membership_id: userMembershipId,
  }
}
