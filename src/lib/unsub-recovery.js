// UNSUBRECOVER.1 — pure click-evidence classifier for the unsubscribe
// recovery effort. No I/O, no imports from the app — see
// scripts/unsub-recovery-report.mjs for the read-only report that calls
// this against the real database.
//
// WHY THIS EXISTS. Until 2026-08-11 this app dropped customer unsubscribes
// on the floor, two ways, and NEITHER leaves a consent_log row:
//   1. Both consent routes carried a flat per-IP rate limiter that was spent
//      BEFORE the token was even read — /api/unsubscribe at 10/15min,
//      /api/preferences at 20/15min shared across GET+PUT. Gmail fires
//      one-click unsubscribes from a shared proxy pool, so many recipients
//      of the same campaign can share a source IP. Whoever overflowed the
//      limiter got a bare 429 and nothing was written anywhere.
//   2. The footer "Unsubscribe" link only opened a confirm page. Anyone who
//      clicked it and closed the tab without confirming left no record
//      either.
//
// The one durable trace left by either failure is Postmark's click tracking
// on the unsubscribe URL itself, landed in campaign_link_clicks (mig 510).
// This module turns that click history into an evidentiary verdict —
// 'human', 'review' or 'scanner' — per contact. It WRITES NOTHING and calls
// nothing; a later, separately-approved step decides what to do with the
// verdict.
//
// ═══════════════════════════════════════════════════════════════════════
// THE BURST RULE WAS TRIED, MEASURED AGAINST PROD, AND REJECTED.
// DO NOT REINSTATE IT AS THE VERDICT. Read this before "fixing" the noise.
// ═══════════════════════════════════════════════════════════════════════
//
// v1 of this file classified purely on whether a contact's clicks fell
// inside a "burst" — a 2-minute UTC bucket shared with several OTHER
// contacts, read as a link-scanner sweeping a mailbox. Sweeping the one
// tunable in that rule against prod (2026-08-14, 161 still-mailable
// click-havers) found no separation:
//
//   BURST_CONTACT_THRESHOLD   verdict human   verdict scanner
//   3 (the original spec)     21              139
//   5                         24              136
//   8                         71              89
//   12                        118             42
//   20                        155             5
//
// There is no plateau anywhere in that sweep. The split moves from 21 to
// 155 purely on where the constant sits, which is the signature of a
// threshold cutting through ONE continuous population, not separating two
// of them. campaign_link_clicks carries no ip_address or user_agent column,
// so nothing else in that table can settle it either.
//
// The hypothesis itself was independently refuted. A link-scanner fetches
// EVERY url in EVERY delivered email, so a scanner-driven contact should
// click the unsubscribe link in close to 100% of the campaigns they were
// sent. Measured across the same 161 contacts (2026-08-14), keyed on
// clicked campaigns ÷ delivered campaigns ("coverage"):
//   coverage <50%    152 contacts   (mean 1.8 clicks / 7.1 campaigns delivered)
//   coverage 50-90%    9 contacts   (mean 3.4 clicks / 5.9 campaigns delivered)
//   coverage >=90%      0 contacts
// Nobody is anywhere near the scanner signature. The tight 2-minute
// clusters the burst rule flagged are just what a multi-thousand-recipient
// send looks like when people read mail in a wave shortly after delivery.
// The burst rule would have silently classified 139 real people as
// 'scanner' — i.e. kept mailing every one of them after they asked to stop,
// which is the exact harm this whole effort exists to repair.
//
// buildBurstIndex()/burstBucketKey() are KEPT: the burst count is still
// useful evidence for a human reviewer (a very bursty click history is
// worth a second look), so it is surfaced per contact as burstClicks. But
// nothing in this file lets burst membership, alone, produce a 'scanner'
// verdict — see the dedicated test for that invariant. BURST_ADVISORY_
// CONTACTS (was BURST_CONTACT_THRESHOLD, 3) is now 8 and named to say so.
//
// ─── THE RULE THAT REPLACED IT: COVERAGE ──────────────────────────────────
//   clickedCampaigns   = distinct campaigns this contact clicked the
//                        unsubscribe link on (NOT a raw click count — one
//                        campaign clicked three times is still 1).
//   coverage           = clickedCampaigns / campaignsDelivered, or null
//                        when campaignsDelivered is 0 (no denominator).
//   verdict:
//     'scanner'  coverage !== null && coverage >= SCANNER_COVERAGE_THRESHOLD (0.9)
//     'review'   coverage !== null && coverage >= REVIEW_COVERAGE_THRESHOLD (0.5), < 0.9
//     'human'    otherwise — including coverage === null, and including a
//                single isolated click against more than one or two
//                delivered campaigns.
//
// ─── DIRECTION OF ERROR ────────────────────────────────────────────────────
// A false positive here costs one marketing email to someone who did not
// ask to leave. A false negative means continuing to mail someone who
// asked — up to six times, per the click history that motivated this whole
// effort. Those costs are not symmetric: prefer 'review' over 'scanner',
// and prefer 'human' over 'review', whenever a case is genuinely ambiguous.
// campaignsDelivered = 0 resolves to 'human' for the same reason — with no
// denominator there is no basis to doubt the request.
//
// This is also why a contact who received exactly ONE campaign and clicked
// its unsubscribe link scores coverage 1.0 and lands in 'scanner': on this
// signal alone, with a single data point, they are indistinguishable from
// a machine. That is a known, accepted rough edge of a coverage-based rule
// (see the test named for it), not an oversight — a human reviewer sees
// the click_count/campaigns_delivered columns in the CSV and can override
// it in seconds, which is cheap; guessing 'human' for every one-email
// contact would quietly readmit any scanner that only ever got one send.

/** Width of a burst-detection bucket, in minutes. Advisory only — see above. */
export const BURST_BUCKET_MINUTES = 2

/**
 * A bucket this many-or-more distinct contacts deep is worth a reviewer's
 * attention (surfaced as burstClicks) but — per the header comment — is
 * advisory only and never sets the verdict.
 */
export const BURST_ADVISORY_CONTACTS = 8

/** coverage >= this -> 'scanner'. The measured machine signature (see header). */
export const SCANNER_COVERAGE_THRESHOLD = 0.9

/** coverage >= this (and below SCANNER_COVERAGE_THRESHOLD) -> 'review'. */
export const REVIEW_COVERAGE_THRESHOLD = 0.5

/**
 * Floor an ISO timestamp into its 2-minute UTC bucket key, e.g.
 * '2026-05-17T18:46:00Z' -> '2026-05-17T18:46'. Two timestamps in the same
 * BURST_BUCKET_MINUTES window produce the same key.
 */
export function burstBucketKey(iso) {
  const d = new Date(iso)
  const mins = Math.floor(d.getUTCMinutes() / BURST_BUCKET_MINUTES) * BURST_BUCKET_MINUTES
  return `${d.toISOString().slice(0, 14)}${String(mins).padStart(2, '0')}`
}

/**
 * rows: [{ contact_id, clicked_at }] — every unsubscribe-link click across
 * every contact (not just one contact's clicks). Returns a plain object
 * { bucketKey: distinctContactCount }, counting DISTINCT contact_id per
 * bucket, not rows. Advisory evidence only — see the header comment for why
 * it no longer drives the verdict.
 */
export function buildBurstIndex(rows) {
  const buckets = new Map()
  for (const row of rows) {
    const key = burstBucketKey(row.clicked_at)
    if (!buckets.has(key)) buckets.set(key, new Set())
    buckets.get(key).add(row.contact_id)
  }
  const index = {}
  for (const [key, contacts] of buckets) index[key] = contacts.size
  return index
}

/**
 * clicks: ONE contact's unsubscribe-link clicks, [{ campaign_id, clicked_at }].
 * campaignsDelivered: total campaigns delivered to this contact (the
 *   coverage denominator). 0/undefined -> coverage null -> 'human'.
 * burstIndex: the shared output of buildBurstIndex() over ALL clicks —
 *   used only to report burstClicks; it cannot change the verdict.
 *
 * Returns { verdict, coverage, clickedCampaigns, clickCount, burstClicks, spanDays }.
 */
export function classifyClickEvidence({ clicks, campaignsDelivered, burstIndex }) {
  const sorted = [...clicks].sort((a, b) => new Date(a.clicked_at) - new Date(b.clicked_at))
  const clickCount = sorted.length

  const clickedCampaigns = new Set(sorted.map(c => c.campaign_id)).size
  const coverage = campaignsDelivered > 0 ? clickedCampaigns / campaignsDelivered : null

  let verdict
  if (coverage !== null && coverage >= SCANNER_COVERAGE_THRESHOLD) verdict = 'scanner'
  else if (coverage !== null && coverage >= REVIEW_COVERAGE_THRESHOLD) verdict = 'review'
  else verdict = 'human'

  // Advisory only (see header) — reported, never consulted for `verdict` above.
  const burstClicks = sorted.filter(
    c => (burstIndex[burstBucketKey(c.clicked_at)] || 0) >= BURST_ADVISORY_CONTACTS,
  ).length

  const first = new Date(sorted[0].clicked_at)
  const last = new Date(sorted[sorted.length - 1].clicked_at)
  const spanDays = clickCount > 1 ? (last - first) / (1000 * 60 * 60 * 24) : 0

  return { verdict, coverage, clickedCampaigns, clickCount, burstClicks, spanDays }
}
