// Re-enrolment cooldown helper (mig 090).
//
// Given the contact's terminal-enrolment history for one sequence,
// returns the set of contact IDs that are currently blocked from
// re-enrolment.
//
// Two regimes:
//   • cooldownDays > 0 → the most recent terminal end per contact
//     must be older than cooldownDays for re-enrolment to be allowed.
//   • cooldownDays null/0 → any prior terminal enrolment blocks
//     (legacy single-enrolment behaviour, preserved so locations
//     that haven't opted into cooldown keep the old guarantees).
//
// Pure — takes the rows that the caller has already read from
// sequence_enrollments + the cooldown setting + the clock; returns
// a Set. Lifted out of enrolContacts so the cooldown semantics can
// be tested without standing up a Supabase mock.

/**
 * @typedef {{ contact_id: string,
 *             status: 'completed' | 'exited',
 *             last_processed_at: string | null,
 *             created_at: string }} EnrolmentHistoryRow
 */

/**
 * @param {EnrolmentHistoryRow[]} history    Rows from
 *   sequence_enrollments where status IN ('completed','exited') for
 *   the candidate contact set.
 * @param {number | null | undefined} cooldownDays
 *   Value of email_sequences.re_enrolment_cooldown_days. Null/0 means
 *   no cooldown configured.
 * @param {number} [nowMs=Date.now()]  Testable clock.
 * @returns {Set<string>}  contact_ids that are blocked from re-enrolment.
 */
export function findBlockedByCooldown(history, cooldownDays, nowMs = Date.now()) {
  const blocked = new Set()
  if (!Array.isArray(history) || history.length === 0) return blocked

  const days = Number(cooldownDays)
  const hasCooldown = Number.isFinite(days) && days > 0

  if (!hasCooldown) {
    // Legacy semantics: any past terminal enrolment blocks.
    for (const h of history) {
      if (h?.contact_id) blocked.add(h.contact_id)
    }
    return blocked
  }

  // Cooldown semantics: pick the most-recent terminal end-time per
  // contact, block if that end-time is within `days` of now.
  const lastEndByContact = new Map()
  for (const h of history) {
    if (!h?.contact_id) continue
    const end = h.last_processed_at || h.created_at
    if (!end) continue
    const prior = lastEndByContact.get(h.contact_id)
    if (!prior || end > prior) lastEndByContact.set(h.contact_id, end)
  }

  const cooldownMs = days * 86_400_000
  for (const [cid, end] of lastEndByContact) {
    const endMs = new Date(end).getTime()
    if (Number.isFinite(endMs) && nowMs - endMs < cooldownMs) {
      blocked.add(cid)
    }
  }
  return blocked
}
