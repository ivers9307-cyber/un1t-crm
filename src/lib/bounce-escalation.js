// GAPS-P5 — repeat-bounce escalation.
//
// WHAT IS ALREADY HANDLED. A HARD bounce is terminal and the Postmark webhook
// already acts on it: postmark-webhook-processor stamps contacts.email_status
// = 'bounced' and auto-unsubscribes, and buildAudienceQuery excludes
// email_status IN ('bounced','complained') from every send. Measured at
// Stillorgan 2026-08-09: 26 hard-bounce events, 26 contacts, 23 flagged. That
// path works and this module does not touch it.
//
// WHAT IS NOT. A SOFT or TRANSIENT bounce is temporary (full mailbox, greylist,
// a receiving server having a bad afternoon) and is correctly not suppressed —
// suppressing on one would be a bug, not a feature. But nothing escalates
// REPEATED failure: 38 contacts soft-bounced 102 times and 30 transient-bounced
// 100 times, and 32 of them failed across 3+ DISTINCT campaigns while never
// hard-bouncing. Fifteen of those 32 have never had a single successful
// delivery — every send ever made to them bounced. Those addresses are dead in
// every sense except that no provider has said the magic word.
//
// THE DECISION. Three outcomes, and only one of them is acted on:
//
//   suppress — bounced in >= BOUNCE_ESCALATION_MIN_CAMPAIGNS distinct
//              campaigns AND zero successful deliveries ever, in EITHER
//              ledger. Nothing has ever reached this address; there is no
//              reading of the history under which it works. (BOUNCEEV.1: "ever"
//              used to mean campaign_recipients only, so a contact who
//              reliably receives transactional mail could still be suppressed
//              — an error in the unsafe direction. email_sends now counts too.)
//   review   — the same bounce record, but the address HAS accepted mail at
//              some point. That is a mailbox that was full for a stretch, or a
//              server that had a bad month. Surfaced to the operator, never
//              acted on automatically.
//   keep     — everything else.
//
// DISTINCT CAMPAIGNS, NOT EVENTS. Three bounces inside one campaign's retry
// sequence is ONE failed delivery observed three times, not three failures.
// Counting events would suppress on a single bad send. Mailchimp suppresses at
// 7 soft bounces with no delivery condition at all; three separate campaigns
// plus never-delivered is deliberately narrower than that.
//
// PURE. No I/O, no clock: `now` is injected and only ever stamps evaluatedAt.
// There is deliberately NO recency window — a mailbox that has never accepted
// anything is not less dead because the bounces are old, and a window would
// silently exempt exactly the longest-dead addresses. The applier
// (bounce-escalation-sweep.js) does the fetching; this file does the deciding.

/** Distinct campaigns that must have bounced before anything escalates. */
export const BOUNCE_ESCALATION_MIN_CAMPAIGNS = 3

/**
 * campaign_recipients.status values that prove the address accepted mail.
 *
 * The column PROGRESSES (queued -> sending -> sent -> delivered -> opened ->
 * clicked), so a contact who opened carries 'opened', not 'delivered'. Reading
 * only ['sent','delivered'] would classify an engaged contact as
 * never-delivered and suppress them.
 */
export const SUCCESSFUL_RECIPIENT_STATUSES = ['sent', 'delivered', 'opened', 'clicked']

/**
 * email_sends.status values that prove the address accepted mail.
 *
 * Same four values, deliberately a SEPARATE constant rather than a re-export:
 * these are two different tables with independently-evolving vocabularies
 * (campaign_recipients also carries 'cancelled', email_sends also carries
 * 'complained'), and a shared constant would quietly redefine one when the
 * other changed. Verified live 2026-08-11 that email_sends.status progresses
 * in the SAME single-column, overwritten-in-place way — 7,888 'opened' rows,
 * of which only 5,915 still carry a delivered_at — so evidence here means
 * "reached AT LEAST sent" too, exactly as WA_REACHED_SENT does for WhatsApp
 * (whatsapp-broadcast-stats.js).
 */
export const SUCCESSFUL_EMAIL_SEND_STATUSES = ['sent', 'delivered', 'opened', 'clicked']

const EVIDENCE_STATUSES = new Set([...SUCCESSFUL_RECIPIENT_STATUSES, ...SUCCESSFUL_EMAIL_SEND_STATUSES])

/**
 * Does one send row prove the address accepted mail? Pure; used for BOTH
 * campaign_recipients and email_sends rows, which carry the same shape.
 *
 * Two independent proofs, because a single progressing status column cannot
 * hold both the high-water mark and the terminal outcome:
 *
 *   1. The status itself has reached at least 'sent'.
 *   2. The row carries a delivered_at / opened_at / clicked_at even though the
 *      status has since been overwritten with a terminal 'bounced' or
 *      'complained'. A deferred bounce arriving after the recipient has
 *      already opened and clicked erases the only status that said so; the
 *      timestamps are what survives. Live 2026-08-11: 24 campaign_recipients
 *      and 21 email_sends rows read 'bounced' with a delivered_at, and one
 *      contact in the currently-suppressed set had FOUR sends delivered,
 *      opened and clicked minutes before a transient bounce landed.
 *
 * bounced_at is deliberately not evidence: a bounce is the opposite of a
 * delivery, and reading it as one would make every bouncer look reachable.
 */
export function isDeliveryEvidence(row) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.status === 'string' && EVIDENCE_STATUSES.has(row.status)) return true
  return Boolean(row.delivered_at || row.opened_at || row.clicked_at)
}

/** The three outcomes, in escalation order. */
export const BOUNCE_ESCALATION_OUTCOMES = ['keep', 'review', 'suppress']

const HARD = 'hard'
const UNKNOWN_BOUNCE_TYPE = 'unknown'

/** Postmark writes hard|soft|transient; history also holds 'rejected'. */
function normaliseBounceType(value) {
  if (typeof value !== 'string') return UNKNOWN_BOUNCE_TYPE
  const trimmed = value.trim().toLowerCase()
  return trimmed || UNKNOWN_BOUNCE_TYPE
}

/** ISO string if the value parses as a date, else null. */
function toIso(value) {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Non-negative integer, or 0 for anything unusable. */
function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Group raw campaign_recipients bounce rows by contact.
 *
 * Separate from the decision so the sweep can page rows in without holding a
 * per-contact assembly loop of its own, and so the grouping is testable.
 *
 * @param {Array<{contact_id?: string}>} rows
 * @returns {Map<string, object[]>}
 */
export function groupBouncesByContact(rows = []) {
  const byContact = new Map()
  for (const row of rows || []) {
    const contactId = row?.contact_id
    if (!contactId) continue
    const list = byContact.get(contactId)
    if (list) list.push(row)
    else byContact.set(contactId, [row])
  }
  return byContact
}

/**
 * Decide what to do about one contact's bounce history.
 *
 * @param {object} history
 * @param {Array<{campaign_id?: string, bounce_type?: string, bounced_at?: string}>} history.bounces
 *   Every bounced campaign_recipients row for this contact, any campaign, any
 *   age. Rows with no campaign_id are counted as events but cannot prove a
 *   distinct campaign failure, so they never push a contact over the threshold.
 * @param {number} history.successfulDeliveries
 *   How many campaign_recipients rows for this contact prove a delivery
 *   (isDeliveryEvidence). Broadcast evidence.
 * @param {number} [history.transactionalDeliveries]
 *   How many NON-campaign email_sends rows for this contact prove a delivery.
 *   Absent reads as zero, which is the pre-BOUNCEEV.1 behaviour: this can only
 *   ever soften a verdict, never harden one. The two counts are disjoint
 *   populations (campaign-sourced email_sends rows are the same sends as the
 *   campaign_recipients rows and are excluded by the loader), so
 *   `totalDeliveries` is a real total and not a double count.
 * @param {object} [opts]
 * @param {Date} [opts.now] injected clock — stamps evaluatedAt only.
 * @returns {{
 *   outcome: 'suppress'|'review'|'keep', reason: string,
 *   distinctCampaignCount: number, campaignIds: string[], bounceTypes: string[],
 *   bounceEvents: number, hasHardBounce: boolean, successfulDeliveries: number,
 *   transactionalDeliveries: number, totalDeliveries: number,
 *   firstBounceAt: string|null, lastBounceAt: string|null, evaluatedAt: string,
 * }}
 */
export function decideBounceEscalation(history = {}, { now = new Date() } = {}) {
  const bounces = Array.isArray(history?.bounces) ? history.bounces : []
  const successfulDeliveries = toCount(history?.successfulDeliveries)
  const transactionalDeliveries = toCount(history?.transactionalDeliveries)
  const totalDeliveries = successfulDeliveries + transactionalDeliveries

  const campaignIds = new Set()
  const bounceTypes = new Set()
  let hasHardBounce = false
  let bounceEvents = 0
  let firstMs = null
  let lastMs = null

  for (const row of bounces) {
    if (!row) continue
    bounceEvents += 1

    const type = normaliseBounceType(row.bounce_type)
    bounceTypes.add(type)
    if (type === HARD) hasHardBounce = true

    if (typeof row.campaign_id === 'string' && row.campaign_id) campaignIds.add(row.campaign_id)

    const iso = toIso(row.bounced_at)
    if (iso) {
      const ms = new Date(iso).getTime()
      if (firstMs === null || ms < firstMs) firstMs = ms
      if (lastMs === null || ms > lastMs) lastMs = ms
    }
  }

  const facts = {
    distinctCampaignCount: campaignIds.size,
    campaignIds: [...campaignIds].sort(),
    bounceTypes: [...bounceTypes].sort(),
    bounceEvents,
    hasHardBounce,
    successfulDeliveries,
    transactionalDeliveries,
    totalDeliveries,
    firstBounceAt: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastBounceAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    evaluatedAt: new Date(now).toISOString(),
  }

  if (bounceEvents === 0) return { outcome: 'keep', reason: 'no_bounces', ...facts }

  // A hard bounce means the Postmark webhook has already stamped
  // email_status='bounced' and unsubscribed them, and the audience gate
  // already excludes them. Escalating here would write a second, redundant
  // suppression record for a contact who is not in any audience anyway, and
  // it would make the repeat-bounce cohort a superset of the hard-bounce one
  // — so the list-health numbers would double-count the same person.
  if (hasHardBounce) return { outcome: 'keep', reason: 'hard_bounce_handled_elsewhere', ...facts }

  if (facts.distinctCampaignCount < BOUNCE_ESCALATION_MIN_CAMPAIGNS) {
    return { outcome: 'keep', reason: 'below_campaign_threshold', ...facts }
  }

  // "Never delivered to" has to mean never delivered to ANYWHERE. Reading only
  // the broadcast ledger let a contact who reliably receives transactional mail
  // be suppressed on the strength of campaign bounces alone — an error in the
  // unsafe direction, since it makes the suppressed set larger than the
  // evidence supports.
  if (totalDeliveries > 0) {
    return { outcome: 'review', reason: 'repeat_bounce_previously_delivered', ...facts }
  }

  return { outcome: 'suppress', reason: 'repeat_bounce_never_delivered', ...facts }
}
