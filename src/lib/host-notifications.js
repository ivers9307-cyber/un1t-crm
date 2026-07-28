// HOST-PORTAL.6 — host-event review notifications.
//
// Two directions: when staff approve/reject a submitted event, the HOST
// hears about it (their event_hosts.email + every linked host_users login);
// when a host submits an event for review, the ORG ADMINS hear about it
// (every master/owner/manager profile across the org's locations).
//
// The build* helpers are pure (unit-tested); the notify* senders are thin
// IO wrappers that do NOT swallow errors — callers run them fire-and-forget
// in their own try/catch after the primary write, per repo convention.

import { sendTransactionalEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { escapeHtml } from '@/lib/event-email'
import { ADMIN_ROLES } from '@/lib/schemas'

/**
 * Dedupe + lowercase the host's own email plus any linked host_users login
 * emails, skipping empties. Order: host email first, then links.
 * @param {{ email?: string|null }|null} host
 * @param {Array<{ email?: string|null }>} links  host_users rows
 * @returns {string[]}
 */
export function assembleHostRecipients(host, links) {
  const out = []
  const seen = new Set()
  for (const raw of [host?.email, ...(links || []).map((l) => l?.email)]) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!email || seen.has(email)) continue
    seen.add(email)
    out.push(email)
  }
  return out
}

/**
 * Email to the HOST after staff review their event.
 * @param {{ event: { name: string, slug: string }, action: 'approve'|'reject', reason?: string|null, appUrl: string }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildReviewedEmail({ event, action, reason, appUrl }) {
  const name = escapeHtml(event?.name || 'Your event')
  if (action === 'approve') {
    const publicUrl = `${appUrl}/event/${event.slug}`
    return {
      subject: `${event?.name || 'Your event'} is live`,
      htmlBody:
        `<p>Good news — <strong>${name}</strong> has been approved and is now live.</p>` +
        `<p>Public page: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>` +
        `<p>You can track sales and attendees from your host portal.</p>`,
    }
  }
  const portalUrl = `${appUrl}/host`
  return {
    subject: `${event?.name || 'Your event'} needs changes`,
    htmlBody:
      `<p><strong>${name}</strong> was reviewed and needs changes before it can go live.</p>` +
      (reason ? `<p>Reviewer's note: ${escapeHtml(reason)}</p>` : '') +
      `<p>Update the event and resubmit from your host portal: ` +
      `<a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a></p>`,
  }
}

/**
 * Email to ORG ADMINS when a host submits an event for review.
 * @param {{ event: { name: string }, host: { name?: string|null }, appUrl: string }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildSubmittedEmail({ event, host, appUrl }) {
  const hostName = escapeHtml(host?.name || 'A host')
  const eventName = escapeHtml(event?.name || 'an event')
  const reviewUrl = `${appUrl}/settings/hosts`
  return {
    subject: `Host event to review: ${event?.name || 'an event'}`,
    htmlBody:
      `<p><strong>${hostName}</strong> submitted <strong>${eventName}</strong> for review.</p>` +
      `<p>Approve or reject it from the review queue: ` +
      `<a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a></p>`,
  }
}

/**
 * Notify the host (their email + linked logins) that their event was
 * approved or rejected. Throws on failure — caller wraps (fire-and-forget).
 * @param {{ db: import('@supabase/supabase-js').SupabaseClient, event: object, host: object, action: 'approve'|'reject', reason?: string|null }} args
 */
export async function notifyHostEventReviewed({ db, event, host, action, reason }) {
  const { data: links } = await db.from('host_users').select('email').eq('host_id', host.id)
  const recipients = assembleHostRecipients(host, links || [])
  if (recipients.length === 0) return
  const msg = buildReviewedEmail({ event, action, reason, appUrl: getAppUrl() })
  for (const to of recipients) {
    await sendTransactionalEmail({
      to,
      subject: msg.subject,
      htmlBody: msg.htmlBody,
      locationId: event.location_id,
      tag: 'host-event-review',
    })
  }
}

/**
 * Notify every org admin (master/owner/manager across the org's locations)
 * that a host submitted an event for review. Throws on failure — caller
 * wraps (fire-and-forget).
 * @param {{ db: import('@supabase/supabase-js').SupabaseClient, event: object, host: object, orgId: string }} args
 */
export async function notifyAdminsEventSubmitted({ db, event, host, orgId }) {
  const { data: locs } = await db.from('locations').select('id').eq('organization_id', orgId)
  const locIds = (locs || []).map((l) => l.id)
  if (locIds.length === 0) return
  const { data: pls } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', locIds)
    .in('role', ADMIN_ROLES)
  const profileIds = [...new Set((pls || []).map((r) => r.profile_id).filter(Boolean))]
  if (profileIds.length === 0) return

  // HOST-APPROVALS.1 — push first (the email below predates the approvals
  // integration and stays as the durable record). Keyed on event+submission
  // so a resubmit after rejection pushes again; deduped per recipient.
  // Best-effort — a push hiccup never blocks the emails.
  try {
    const { sendPushOnce } = await import('@/lib/push-dedup')
    await sendPushOnce(db, `host_event_review:${event.id}:${event.submitted_at || ''}`, profileIds, {
      title: 'Approval needed · Host event',
      body: `${host.name || 'A host'} submitted "${event.name}" for review.`,
      category: 'host_event_review',
      data: { type: 'host_event_review', event_id: event.id },
    })
  } catch (e) {
    console.warn(`[host-notifications] submit push failed: ${e?.message || e}`)
  }

  const { data: profiles } = await db.from('profiles').select('email').in('id', profileIds)
  // Reuse the tested dedupe/lowercase/skip-empty pass (no host email here).
  const recipients = assembleHostRecipients({ email: null }, profiles || [])
  if (recipients.length === 0) return
  const msg = buildSubmittedEmail({ event, host, appUrl: getAppUrl() })
  for (const to of recipients) {
    await sendTransactionalEmail({
      to,
      subject: msg.subject,
      htmlBody: msg.htmlBody,
      locationId: event.location_id,
      tag: 'host-event-submitted',
    })
  }
}
