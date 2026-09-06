// GAPS-P7 — the ONE definition of what a `consent_log.source` MEANS.
//
// Sibling of consent-actions.js (GAPS-P6), and it exists for the same reason.
// That module fixed a column with two spellings of one fact. This one fixes a
// column with twelve values that are not the same KIND of fact at all, and
// were being summed as though they were.
//
// WHAT WENT WRONG WITHOUT IT
// ──────────────────────────
// The first cut of list_health_monthly_stats (mig 517) counted every
// `action = 'opt_out'` row as a departure. Measured live, `consent_log` holds
// 5,749 email_marketing opt-outs since 2026-05-01:
//
//     bulk_import                    3,963   all on 2026-05-13
//     auto_classpass_backfill        1,533   all on 2026-05-13
//     auto_classpass                    82   ongoing
//     postmark_one_click_unsubscribe    56   ongoing
//     event_form                        38   ongoing
//     one_click_unsubscribe             27   ongoing
//     postmark_suppression_backfill     23   all on 2026-05-13
//     postmark_hard_bounce              18   ongoing
//     admin_panel                        4   ongoing
//     booking_form                       2   ongoing
//     leadcap1_scope_correction          2   2026-08-06
//     postmark_spam_complaint            1   2026-08-05
//
// 5,519 of those landed on ONE DAY as a data migration. Summed blind, May 2026
// reads as roughly 5,536 departures and a net near -5,534: a one-day import
// rendered as a catastrophic list collapse, on the single number this whole
// feature exists to make trustworthy.
//
// A BLOCKLIST WOULD NOT HAVE FIXED IT. Naming the three backfills and moving
// on leaves the next import to reappear in the headline silently, which is how
// this arrived in the first place. So the mapping is total and explicit, and
// an UNMAPPED source is surfaced as its own visible bucket rather than
// defaulting into any category. A source nobody has classified must show up on
// screen as unclassified, not quietly become churn.
//
// PRECEDENT: mig 488 already had to hand-exclude `leadcap1_scope_correction`
// from a genuine-opt-out query. That is the same trap in the same column, and
// it was solved once, locally, where the next query could not see it.
//
// ⚠️ NOT EVERY ROW IS A FLIP. applyMarketingPreferences[Bulk] writes a
// consent_log row only when the flag actually CHANGED, so its rows are true
// transitions. The auto_classpass TRIGGER (mig 512) and the backfills do NOT:
// the trigger fires on every transition into classpass_payg and inserts
// unconditionally, so one person churning in and out of ClassPass writes
// several opt_out rows while leaving the list exactly once. Anything counting
// rows as people must therefore exclude those sources, which is a second,
// independent reason the categories below exist.

/** The five buckets. `unknown` is a real outcome, not an error value. */
export const CONSENT_SOURCE_CATEGORIES = Object.freeze({
  /** A person chose this: a form, a preference centre, an unsubscribe link, or staff recording their stated wish. */
  VOLUNTARY: 'voluntary',
  /** The address itself failed: a permanent bounce, or a spam report. Real lost reach. */
  DELIVERABILITY: 'deliverability',
  /** A standing rule made them unmailable. Nobody left; a system reclassified them. */
  POLICY: 'policy',
  /** A one-off migration or correction. Never a departure, never an arrival. */
  BULK: 'bulk',
  /** Not in this registry. Counted nowhere, shown loudly. */
  UNKNOWN: 'unknown',
})

const { VOLUNTARY, DELIVERABILITY, POLICY, BULK, UNKNOWN } = CONSENT_SOURCE_CATEGORIES

/**
 * Every source this codebase writes, plus the historical ones still on disk.
 *
 * Over-inclusion is deliberate and safe: a mapped source that never appears
 * costs nothing, while a missing one lands in `unknown` and appears on screen.
 * WhatsApp-only sources are listed even though the email trend filters
 * channel='email_marketing' and will never see them, because the registry is
 * about the vocabulary, not about one reader's filter.
 */
export const CONSENT_SOURCE_CATEGORY = Object.freeze({
  // ── voluntary: a person's own decision ────────────────────────────
  preference_centre:              VOLUNTARY,
  one_click_unsubscribe:          VOLUNTARY,
  postmark_one_click_unsubscribe: VOLUNTARY,
  event_form:                     VOLUNTARY,
  booking_form:                   VOLUNTARY,
  waitlist_form:                  VOLUNTARY,
  start_class:                    VOLUNTARY,
  host_mailing_list:              VOLUNTARY,
  mailing_list:                   VOLUNTARY,
  whatsapp_flow:                  VOLUNTARY,
  whatsapp_keyword:               VOLUNTARY,
  meta_user_preferences:          VOLUNTARY,
  // Staff recording a choice the person made by phone or at the desk. It is
  // still that person's decision; the desk is just the surface it arrived on.
  admin_panel:                    VOLUNTARY,
  manual:                         VOLUNTARY,

  // HOST-CONSENT.1 — a host's own mailing list, per-host, never touching
  // UN1T marketing consent. See src/lib/host-consent.js.
  mailing_list_form:              VOLUNTARY, // host /h/[slug] signup
  host_resubscribe:               VOLUNTARY, // re-signup after a host unsubscribe
  host_unsubscribe_page:          VOLUNTARY, // host footer link landing page
  host_one_click_unsubscribe:     VOLUNTARY, // RFC 8058 POST on host mail

  // ── deliverability: the address failed ────────────────────────────
  postmark_hard_bounce:           DELIVERABILITY,
  postmark_spam_complaint:        DELIVERABILITY,

  // ── policy: a standing rule, not a departure ──────────────────────
  // The mig 512 trigger, firing on a Glofox membership transition into
  // classpass_payg. See NET_LIST_CHANGE_CATEGORIES for why it is excluded
  // from the headline.
  auto_classpass:                 POLICY,
  // DUPEUNSUB.1 — mirrored from a sibling contact record that shares this
  // person's email or phone. POLICY, not VOLUNTARY: the person made one
  // decision, and counting it once per duplicate record would inflate the
  // NET LIST CHANGE headline by however many duplicates we happen to hold.
  duplicate_propagation:          POLICY,

  // ── bulk: one-off migrations and corrections ──────────────────────
  bulk_import:                    BULK,
  import:                         BULK,
  auto_classpass_backfill:        BULK,
  postmark_suppression_backfill:  BULK,
  // UNSUBRECOVER.3 (mig 545) — reconstructed from campaign_link_clicks
  // evidence that the person clicked an unsubscribe link during the window
  // when the per-IP limiters were dropping opt-outs with nothing written.
  // BULK: a correction, so it must not move the NET LIST CHANGE headline —
  // the departure it records already happened, months earlier.
  unsub_click_recovery:           BULK,
  // Already hand-excluded from a genuine-opt-out query by mig 488.
  leadcap1_scope_correction:      BULK,
})

/**
 * The categories that move NET LIST CHANGE.
 *
 * `voluntary` — obviously. Somebody joined or left.
 *
 * `deliverability` — yes. A permanently bounced address is reach that is
 * genuinely gone, and a spam report is a departure stated in the rudest
 * available terms. Both are consequences of the email programme, which is what
 * this number is about.
 *
 * `policy` — NO, and this is the arguable one. Three reasons, and the person
 * is still counted as unmailable elsewhere on the page:
 *
 *   1. It is a MEMBERSHIP event wearing consent's clothes. The trigger fires
 *      on glofox_membership_status transitioning to classpass_payg. Folding it
 *      into the marketing headline means a Glofox sync moves a number the
 *      comms operator cannot influence, and reads to them as their emails
 *      driving people away.
 *   2. It only ever RATCHETS DOWN. The trigger has no counterpart on the way
 *      out: nothing re-opts-in a contact who stops being ClassPass PAYG. A
 *      metric that can only fall from this source would drift permanently
 *      negative regardless of what the marketing actually did.
 *   3. It does not count PEOPLE. The trigger inserts unconditionally rather
 *      than on a flip, so one person moving in and out of ClassPass writes
 *      several rows. Netting them would overstate the loss.
 *
 * Nothing is hidden by that choice: the "Can be emailed now" figure on this
 * same page comes from the send builder itself, so every ClassPass exclusion
 * is already reflected in the number that decides who gets mail. Policy
 * exclusions are also shown per month, in their own labelled column, next to
 * the net. They are excluded from the headline, not from the page.
 *
 * `bulk` — never. A row written by a migration is evidence of a migration.
 *
 * `unknown` — never, on purpose. Guessing is how the original defect got in.
 */
export const NET_LIST_CHANGE_CATEGORIES = Object.freeze([VOLUNTARY, DELIVERABILITY])

/**
 * The category for a stored source. Case- and whitespace-tolerant, because the
 * column is free text written by a dozen call sites and one Postgres trigger.
 *
 * An unrecognised source returns 'unknown'. It is NOT coerced into a
 * neighbouring category and NOT dropped: both would restore the silence this
 * module exists to end.
 *
 * @param {string|null|undefined} source
 * @returns {'voluntary'|'deliverability'|'policy'|'bulk'|'unknown'}
 */
export function categoriseConsentSource(source) {
  if (typeof source !== 'string') return UNKNOWN
  const key = source.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(CONSENT_SOURCE_CATEGORY, key)
    ? CONSENT_SOURCE_CATEGORY[key]
    : UNKNOWN
}

/**
 * Every source in one category, as an array.
 *
 * This is what gets handed to list_health_monthly_stats (mig 517) as a
 * parameter. The RPC holds NO copy of the vocabulary: the mapping lives here
 * and travels to Postgres on every call, so there is exactly one place to edit
 * when a source is added. The RPC's array parameters default to empty, which
 * makes a caller that forgets them classify EVERYTHING as unknown -- loudly
 * wrong on screen rather than quietly wrong in the headline.
 *
 * @param {string} category
 * @returns {string[]} sorted, so the argument is stable across calls
 */
export function sourcesInCategory(category) {
  return Object.keys(CONSENT_SOURCE_CATEGORY)
    .filter((s) => CONSENT_SOURCE_CATEGORY[s] === category)
    .sort()
}

/** True when a row from this source should move the net list change. */
export function countsTowardNetListChange(source) {
  return NET_LIST_CHANGE_CATEGORIES.includes(categoriseConsentSource(source))
}

/** The four category argument arrays, in the shape the RPC takes. */
export function consentSourceRpcArgs() {
  return {
    p_voluntary_sources: sourcesInCategory(VOLUNTARY),
    p_deliverability_sources: sourcesInCategory(DELIVERABILITY),
    p_policy_sources: sourcesInCategory(POLICY),
    p_bulk_sources: sourcesInCategory(BULK),
  }
}
