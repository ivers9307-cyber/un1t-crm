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
//   • an operator releases it from the list-health hygiene surface
//     (HYGREL.1) — which, unlike the first two, is PERMANENT
//
// HYGREL.1 — that third route used to read "an operator can clear it in
// the DB", and that was the honest description: the only release path
// keyed on an escalation row id (mig 515), so the 1,107 contacts this
// sweep stamped with no escalation behind them could only be freed by
// hand-written SQL, leaving no audit row. There is now an operator
// surface, an audit table (email_hygiene_releases) and a gate column
// (contacts.email_hygiene_released_at, both mig 535). The gate is NOT
// part of the pure predicate below — it filters the CANDIDATE
// POPULATION, in the cron's own contacts query, because a contact who
// has been released should never be fetched, scored or counted. Keep
// the two in step: this module owns "does the evidence say suppress",
// the route owns "is this contact eligible to be asked".
//
// Gates that read the stamp:
//   • buildAudienceQuery/buildAudienceQueryAsync (marketing consent
//     path only — administrative mail is NEVER suppressed)
//   • sendEmailStep in sequences (recorded skip, same idiom as the
//     consent gate)

// ── Thresholds (conservative by design) ─────────────────────────
//
// A contact is suppressed only when ALL hold:
//   0. no operator release on record (email_hygiene_released_at IS
//      NULL, mig 535) — applied by the cron's candidate query, not by
//      the predicate below, and permanent by design
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

// ── HYGREL.1 — the operator release surface ─────────────────────
export const HYGIENE_RELEASES_TABLE = 'email_hygiene_releases'

// Page size for the hygiene-suppression list. Every .select() is capped
// at 1,000 rows regardless of .limit() (CLAUDE.md invariant) and this
// list is ~1,100 rows on day one, so the endpoint is paginated rather
// than bounded — a bounded list would quietly hide the tail, which is
// the exact failure this whole surface exists to fix.
export const HYGIENE_LIST_PAGE_DEFAULT = 100
export const HYGIENE_LIST_PAGE_MAX = 200

/**
 * Why a contact with marketing consent switched on is still unmailable.
 *
 * The contact card used to render "Email marketing: ON" beside a contact
 * that no send would ever reach, because consent and deliverability are
 * different columns and only consent was on screen. This turns the other
 * two columns into one operator-facing sentence.
 *
 * Ordering is by WHICH GATE FIRES FIRST in buildAudienceQuery: reputation
 * (email_status) is applied to administrative mail as well as marketing,
 * so a bounced address is more broken than a suppressed one and is what
 * an operator should be told about first.
 *
 * @returns {null|{kind: string, headline: string, detail: string}} null
 *   when nothing is blocking, so the caller can render nothing at all
 *   rather than a reassuring green box that would be noise.
 */
export function describeEmailBlock({ emailMarketing, emailStatus, emailSuppressedAt } = {}) {
  const status = typeof emailStatus === 'string' ? emailStatus.toLowerCase() : null

  if (status === 'bounced') {
    return {
      kind: 'bounced',
      headline: 'This address is not receiving email',
      detail: 'The last send to it bounced, so every send is skipped, marketing and transactional alike. '
        + 'Correcting the email address here clears the flag.',
    }
  }
  if (status === 'complained') {
    return {
      kind: 'complained',
      headline: 'This address reported a send as spam',
      detail: 'Every send is skipped, marketing and transactional alike. Sending again after a spam report '
        + 'damages the sending domain for everyone, so the flag is not cleared by re-consenting.',
    }
  }
  // Consent off is not a fault to explain — the toggle beside it already
  // says so, and the suppression underneath is moot while it is off.
  if (emailMarketing === false) return null

  if (emailSuppressedAt) {
    return {
      kind: 'hygiene_suppressed',
      headline: 'Marketing email is on, but nothing is being sent',
      detail: 'This contact is held back for list hygiene: no opens and no clicks across at least '
        + `${HYGIENE_MIN_MARKETING_SENDS} marketing emails in ${HYGIENE_WINDOW_DAYS} days, or repeated bounces. `
        + 'Transactional email such as booking confirmations still goes out. Release them from Communications, '
        + 'List health.',
    }
  }
  return null
}

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
