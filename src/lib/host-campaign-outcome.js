// HOST-METRICS.1 — the displayed outcome of one host_campaign_sends row.
//
// `status` is the QUEUE state (pending|claimed|sent|failed). Everything Postmark
// tells us afterwards lands as timestamps, and the outcome is DERIVED here by
// precedence so a late Delivery can never regress an Open (the POSTMARK-RACE.2
// lesson on email_sends.status). host_campaign_stats() (migs 590/591) is a
// cumulative FUNNEL (an opened row also counts as delivered; a clicked row
// also counts as opened), while deriveOutcome is EXCLUSIVE (one label per row,
// unsubscribed beats clicked). They share only the failed / bounced /
// complained exclusions. UI filters must use the funnel predicates (opened_at
// set and not bounced/complained), never outcome equality, or the tile and
// the list disagree.

export const OUTCOMES = Object.freeze(['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued'])

const HARD_BOUNCE_TYPES = new Set(['HardBounce', 'BadEmailAddress', 'Blocked', 'ManuallyDeactivated', 'Unsubscribe'])
const SOFT_BOUNCE_TYPES = new Set(['SoftBounce', 'DnsError', 'Transient', 'SMTPApiError', 'AutoResponder', 'DMARCPolicy', 'TemplateRenderingFailed'])

/**
 * Postmark's bounce `Type` string -> our hard/soft/transient bucket. Shared
 * by the webhook (Bounce case) and the backfill (bounce-log fold) so the two
 * paths can never classify the same Postmark type differently. Anything not
 * in either set — including an undefined/null type, e.g. no bounce-log match
 * at all — reads as 'transient' (unknown), never defaults to 'hard'.
 * @param {string|null|undefined} postmarkType
 * @returns {'hard'|'soft'|'transient'}
 */
export function bounceTypeFrom(postmarkType) {
  if (HARD_BOUNCE_TYPES.has(postmarkType)) return 'hard'
  if (SOFT_BOUNCE_TYPES.has(postmarkType)) return 'soft'
  return 'transient'
}

export function deriveOutcome(row) {
  if (!row) return 'queued'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'pending' || row.status === 'claimed') return 'queued'
  if (row.bounced_at) return 'bounced'
  if (row.complained_at) return 'complained'
  if (row.unsubscribed_at) return 'unsubscribed'
  if (row.clicked_at) return 'clicked'
  if (row.opened_at) return 'opened'
  if (row.delivered_at) return 'delivered'
  return 'sent'
}

/** The timestamp the derived outcome refers to, or null (queued). */
export function outcomeAt(row) {
  switch (deriveOutcome(row)) {
    // claim time is the closest thing to a failure time; there is no failed_at
    case 'failed': return row.claimed_at || row.sent_at || null
    case 'bounced': return row.bounced_at
    case 'complained': return row.complained_at
    case 'unsubscribed': return row.unsubscribed_at
    case 'clicked': return row.clicked_at
    case 'opened': return row.opened_at
    case 'delivered': return row.delivered_at
    case 'sent': return row.sent_at || null
    default: return null
  }
}

// Host-facing copy for failed_reason. Operator tone, no em-dashes (house rule
// for customer-facing text; hosts are customers of the platform).
export const FAILURE_COPY = Object.freeze({
  no_host_consent: 'Not consented to your list',
  host_unsubscribed: 'Unsubscribed from your list',
  mailbox_blocked: 'Mailbox rejected earlier mail',
  no_email: 'No email address',
  no_administrative_consent: 'Not opted in to event updates',
  send_error: 'Mail server rejected the send',
  stale_claim: 'Send timed out',
})

export function failureCopy(reason) {
  return FAILURE_COPY[reason] || 'Could not be sent'
}
