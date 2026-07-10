// EMAIL-HYGIENE.1 — engagement-based email list hygiene.
//
// docs/EMAIL_DELIVERABILITY.md: "Suppress addresses that haven't opened
// in 90 days. Sending to dead addresses is the fastest way to wreck
// domain reputation." This module owns the suppression PREDICATE (pure,
// unit-tested) and the paginated data fetchers the nightly sweep cron
// uses to evaluate it (src/app/api/cron/email-engagement-sweep).
//
// The stamp is contacts.email_suppressed_at (mig 395) — OUR hygiene
// call, deliberately distinct from consent (contact_preferences /
// contacts.email_marketing, which is the CONTACT's choice). It is
// reversible three ways:
//   • any Open/Click webhook clears it (postmark-webhook-processor)
//   • re-consenting via the preference centre clears it
//   • an operator can clear it in the DB
//
// Gates that read the stamp:
//   • buildAudienceQuery/buildAudienceQueryAsync (marketing consent
//     path only — administrative mail is NEVER suppressed)
//   • sendEmailStep in sequences (recorded skip, same idiom as the
//     consent gate)

// ── Thresholds (conservative by design) ─────────────────────────
//
// A contact is suppressed only when ALL hold:
//   1. email_marketing = true (still consented — unsubscribed contacts
//      are already excluded by the consent gate; suppression is for
//      consented-but-dead addresses)
//   2. not already suppressed
//   3. ≥ HYGIENE_MIN_MARKETING_SENDS marketing (broadcast-stream)
//      sends in the last HYGIENE_WINDOW_DAYS — one or two ignored
//      emails prove nothing
//   4. ZERO opens AND ZERO clicks in the window (any stream — any
//      engagement at all rescues the address)
//   5. their FIRST marketing send is OLDER than the window — a contact
//      whose entire history is recent hasn't had 90 days to engage yet
export const HYGIENE_WINDOW_DAYS = 90
export const HYGIENE_MIN_MARKETING_SENDS = 3

export function hygieneCutoffIso(now = new Date()) {
  return new Date(now.getTime() - HYGIENE_WINDOW_DAYS * 86_400_000).toISOString()
}

/**
 * Pure suppression predicate over pre-fetched rows.
 *
 * @param {string[]} contactIds — the candidate population (already
 *   filtered to email_marketing=true AND email_suppressed_at IS NULL)
 * @param {Array<{contact_id: string}>} windowSends — broadcast-stream
 *   email_sends rows with sent_at >= cutoff for these contacts
 * @param {Set<string>} engagedIds — contact ids with ANY open/click
 *   (opened_at/clicked_at >= cutoff) on ANY stream
 * @param {Set<string>} preWindowSenderIds — contact ids with at least
 *   one broadcast send BEFORE the cutoff (i.e. first send >window ago)
 * @returns {string[]} contact ids to suppress, in input order
 */
export function computeSuppressionCandidates({ contactIds, windowSends, engagedIds, preWindowSenderIds }) {
  const sendCounts = new Map()
  for (const row of windowSends) {
    sendCounts.set(row.contact_id, (sendCounts.get(row.contact_id) || 0) + 1)
  }
  return contactIds.filter((id) =>
    (sendCounts.get(id) || 0) >= HYGIENE_MIN_MARKETING_SENDS
    && !engagedIds.has(id)
    && preWindowSenderIds.has(id)
  )
}

// ── Paginated fetchers ──────────────────────────────────────────
//
// Every .select() is capped at 1,000 rows regardless of .limit()
// (CLAUDE.md invariant), so each fetch .range()-paginates with an
// explicit .order(). PAGE mirrors the cap.
const PAGE = 1000

async function fetchAllPages(buildQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * Broadcast-stream sends inside the window for a set of contacts.
 * Returns raw rows ({ contact_id }) for computeSuppressionCandidates.
 */
export async function fetchWindowMarketingSends(db, contactIds, cutoffIso) {
  if (contactIds.length === 0) return []
  return fetchAllPages(() => db
    .from('email_sends')
    .select('contact_id')
    .in('contact_id', contactIds)
    .eq('postmark_stream', 'broadcast')
    .gte('sent_at', cutoffIso)
    .order('id'))
}

/**
 * Contact ids with ANY engagement (open or click) inside the window —
 * any stream: a contact reading their booking confirmations is not a
 * dead address, so transactional engagement rescues them too.
 */
export async function fetchEngagedContactIds(db, contactIds, cutoffIso) {
  if (contactIds.length === 0) return new Set()
  const rows = await fetchAllPages(() => db
    .from('email_sends')
    .select('contact_id')
    .in('contact_id', contactIds)
    .or(`opened_at.gte.${cutoffIso},clicked_at.gte.${cutoffIso}`)
    .order('id'))
  return new Set(rows.map((r) => r.contact_id))
}

/**
 * Contact ids with at least one broadcast send BEFORE the cutoff
 * (first send older than the window). Only called for contacts that
 * already passed the count + zero-engagement checks, so the id set
 * is small even though dead contacts can have long send histories.
 */
export async function fetchPreWindowSenderIds(db, contactIds, cutoffIso) {
  if (contactIds.length === 0) return new Set()
  const rows = await fetchAllPages(() => db
    .from('email_sends')
    .select('contact_id')
    .in('contact_id', contactIds)
    .eq('postmark_stream', 'broadcast')
    .lt('sent_at', cutoffIso)
    .order('id'))
  return new Set(rows.map((r) => r.contact_id))
}
