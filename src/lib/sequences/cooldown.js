// Re-enrolment cooldown helper (mig 090).
//
// Given the contact's terminal-enrolment history for one sequence,
// returns the set of contact IDs that are currently blocked from
// re-enrolment.
//
// Two regimes:
//   • cooldownDays > 0 → the most recent terminal end per contact
//     must be older than cooldownDays for re-enrolment to be allowed.
//     COOLDOWN.1 — the clock starts when the run ENDED (completed or
//     exited): the latest of completed_at, exited_at and last_processed_at
//     (writers stamp different ones; every runner exit stamps the last),
//     else enrolled_at.
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
    // ENROLFIX.1 — the real row carries enrolled_at (there is no created_at
    // on sequence_enrollments); created_at is kept only for older callers.
    const end = runEndedAt(h)
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

/**
 * When a terminal run ended — the instant the cooldown is measured from.
 * @param {{ completed_at?: string|null, exited_at?: string|null, last_processed_at?: string|null, enrolled_at?: string|null, created_at?: string|null }} h
 * @returns {string|null}
 */
export function runEndedAt(h) {
  let latest = null
  let latestMs = -Infinity
  for (const v of [h?.completed_at, h?.exited_at, h?.last_processed_at]) {
    const ms = v ? new Date(v).getTime() : NaN
    if (Number.isFinite(ms) && ms > latestMs) { latest = v; latestMs = ms }
  }
  return latest || h?.enrolled_at || h?.created_at || null
}

/**
 * DUNNING.2 — decide, per contact, whether a TERMINAL enrolment row may be
 * re-activated for a fresh run. COOLDOWN.1 — every enrolContacts caller uses
 * it: the dunning paths (`allowReenrol`) pass their sourceRef so a repeat of
 * the same invoice is refused; everyone else passes null, so the cooldown
 * alone decides.
 *
 *   'blocked'      — inside the cooldown, or no cooldown configured
 *   'same_source'  — the new sourceRef equals the latest run's source_ref
 *                    (Glofox re-sends PAST_DUE on every retry of ONE invoice;
 *                    subscription dunning reuses the invoice id — that is not
 *                    a new failure). A null sourceRef always qualifies.
 *   'reactivate'   — outside the cooldown, different source → run again
 *
 * @param {Array<{ id:string, contact_id:string, status:string, last_processed_at?:string|null, created_at?:string, source_ref?:string|null }>} history
 *   terminal rows (completed / exited) for the candidate contacts
 * @param {number|null|undefined} cooldownDays
 * @param {string|null} sourceRef   the new run's source ref
 * @param {number} [nowMs]
 * @param {{ includePreviousRuns?: boolean }} [opts]  COOLDOWN.1 — also refuse
 *   a sourceRef that any EARLIER run (metadata.previous_runs) carried, not
 *   just the latest one. The general re-entry path sets it: a sweep that
 *   re-offers the same purchase for 48 hours must never start a second run
 *   for it, however the runs in between went. Dunning keeps its own rule.
 * @returns {Map<string, { decision: 'blocked'|'same_source'|'reactivate', row: object }>}
 */
export function planReenrolments(history, cooldownDays, sourceRef, nowMs = Date.now(), { includePreviousRuns = false } = {}) {
  const out = new Map()
  if (!Array.isArray(history) || history.length === 0) return out
  // Latest terminal row per contact (the one a re-run would revive).
  const latest = new Map()
  for (const h of history) {
    if (!h?.contact_id) continue
    const end = runEndedAt(h) || ''
    const prior = latest.get(h.contact_id)
    if (!prior || end > (runEndedAt(prior) || '')) latest.set(h.contact_id, h)
  }
  const blocked = findBlockedByCooldown(history, cooldownDays, nowMs)
  for (const [cid, row] of latest) {
    let decision = 'reactivate'
    if (blocked.has(cid)) decision = 'blocked'
    else if (sourceRef != null && row.source_ref != null && String(row.source_ref) === String(sourceRef)) decision = 'same_source'
    else if (sourceRef != null && includePreviousRuns && previousRunRefs(row).has(String(sourceRef))) decision = 'same_source'
    out.set(cid, { decision, row })
  }
  return out
}

/** Source refs of the runs recorded on a row's metadata.previous_runs. */
function previousRunRefs(row) {
  const runs = row?.metadata && typeof row.metadata === 'object' && Array.isArray(row.metadata.previous_runs)
    ? row.metadata.previous_runs
    : []
  const refs = new Set()
  for (const r of runs) if (r && r.source_ref != null) refs.add(String(r.source_ref))
  return refs
}
