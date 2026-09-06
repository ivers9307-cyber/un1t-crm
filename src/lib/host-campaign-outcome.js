// HOST-METRICS.1 — the displayed outcome of one host_campaign_sends row.
//
// `status` is the QUEUE state (pending|claimed|sent|failed). Everything Postmark
// tells us afterwards lands as timestamps, and the outcome is DERIVED here by
// precedence so a late Delivery can never regress an Open (the POSTMARK-RACE.2
// lesson on email_sends.status). host_campaign_stats() in mig 590 counts with
// the same precedence — keep the two in step.

export const OUTCOMES = Object.freeze(['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued'])

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
