// ORGCONTACTS.7 (mig 770) — the un1t.online membership facts live on the
// relationship row (contact_studios.membership_plan / _status / _since /
// _ended_at; the un1t sync is their one writer, src/lib/contact-studios.js
// setMembershipFacts). The pure un1t shapes (shapeFlows, shapeWinbackRows,
// shapePipelineSnapshot, shapePipelineDateEvidence) have always taken the
// old contact_memberships row shape, so every reader maps through here and
// the shapes stay untouched. The mapped source is 'un1t_online_api': the
// shapes keep only rows of their own source, and the columns carry only
// what the un1t sync wrote.

/** The columns a facts read selects off contact_studios (plus whatever the reader needs beside them). */
export const MEMBERSHIP_FACT_READ_COLS = 'contact_id, membership_plan, membership_status, membership_since, membership_ended_at'

/**
 * contact_studios rows → { contact_id, source, status, ended_at, plan_name, first_seen_at }.
 * Rows with no membership recorded (membership_status null) are dropped; order kept.
 */
export function membershipRowsFromStudioRows(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const r of rows) {
    if (!r || r.membership_status == null) continue
    out.push({
      contact_id: r.contact_id,
      source: 'un1t_online_api',
      status: r.membership_status,
      ended_at: r.membership_ended_at ?? null,
      plan_name: r.membership_plan ?? null,
      first_seen_at: r.membership_since ?? null,
    })
  }
  return out
}
