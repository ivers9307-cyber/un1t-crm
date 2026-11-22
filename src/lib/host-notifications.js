// HOST-PORTAL.6 — host-event review notifications.
//
// Two directions: when staff approve/reject a submitted event, the HOST
// hears about it (their event_hosts.email + every linked host_users login);
// when a host publishes an event, the ORG ADMINS hear about it (every
// master/owner/manager profile across the org's locations).
//
// HOSTAUTOPUB.1 — hosts publish straight away, so the admins' message is a
// NOTICE ("this went live"), not a request to approve. The approve/reject
// email to the host stays for rows left in pending_review from before, which
// staff can still decide on /settings/hosts.
//
// The build* helpers are pure (unit-tested); the notify* senders are thin
// IO wrappers that do NOT swallow errors — callers run them fire-and-forget
// in their own try/catch after the primary write, per repo convention.

import { sendTransactionalEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
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
 * Email to the HOST after staff review their event. `baseUrl` is the tenant
 * host the host's links land on (W1.L3b; notifyHostEventReviewed resolves it).
 * @param {{ event: { name: string, slug: string }, action: 'approve'|'reject', reason?: string|null, baseUrl: string }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildReviewedEmail({ event, action, reason, baseUrl }) {
  const name = escapeHtml(event?.name || 'Your event')
  if (action === 'approve') {
    const publicUrl = `${baseUrl}/event/${event.slug}`
    return {
      subject: `${event?.name || 'Your event'} is live`,
      htmlBody:
        `<p>Good news — <strong>${name}</strong> has been approved and is now live.</p>` +
        `<p>Public page: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>` +
        `<p>You can track sales and attendees from your host portal.</p>`,
    }
  }
  const portalUrl = `${baseUrl}/host`
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
 * Email to ORG ADMINS when a host publishes an event (HOSTAUTOPUB.1): a
 * notice, nothing to approve. A STAFF link: `appUrl` stays the CRM host
 * (getAppUrl), untouched by W1.L3b. It opens the event's staff edit page,
 * where its active switch takes it down.
 * @param {{ event: { id: string, name: string, slug?: string|null }, host: { name?: string|null }, appUrl: string, publicBaseUrl?: string|null }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildPublishedEmail({ event, host, appUrl, publicBaseUrl = null }) {
  const hostName = escapeHtml(host?.name || 'A host')
  const eventName = escapeHtml(event?.name || 'an event')
  const staffUrl = `${appUrl}/events/${event?.id}/edit`
  const publicUrl = publicBaseUrl && event?.slug ? `${publicBaseUrl}/event/${event.slug}` : null
  return {
    subject: `Host event published: ${event?.name || 'an event'}`,
    htmlBody:
      `<p><strong>${hostName}</strong> published <strong>${eventName}</strong>. It is on sale now; nothing needs your approval.</p>` +
      (publicUrl ? `<p>Public page: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>` : '') +
      `<p>To check it, or take it down, open it in the CRM: ` +
      `<a href="${escapeHtml(staffUrl)}">${escapeHtml(staffUrl)}</a></p>`,
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
  // W1.L3b — the host is a customer of the platform: their links land on the
  // tenant host of their anchor location (the event's own location when the
  // caller's host row carries no anchor; NULL → the resolver floors to the CRM
  // host and never throws past it).
  const baseUrl = await resolveCustomerBaseUrl(db, host?.anchor_location_id || event?.location_id || null)
  const msg = buildReviewedEmail({ event, action, reason, baseUrl })
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
 * The org's locations (id, name) and every admin profile across them
 * (master/owner/manager). Scoped to the org in code (service role).
 * @returns {Promise<{ locations: Array<{ id: string, name: string|null }>, profileIds: string[] }>}
 */
async function loadOrgAdmins(db, orgId) {
  const { data: locs } = await db.from('locations').select('id, name').eq('organization_id', orgId)
  const locations = (locs || []).filter((l) => l?.id)
  if (locations.length === 0) return { locations, profileIds: [] }
  const { data: pls } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', locations.map((l) => l.id))
    .in('role', ADMIN_ROLES)
  const profileIds = [...new Set((pls || []).map((r) => r.profile_id).filter(Boolean))]
  return { locations, profileIds }
}

/**
 * Tell every org admin (master/owner/manager across the org's locations) that
 * a host published an event (HOSTAUTOPUB.1). Informational: no approval item
 * exists for it. Throws on failure — caller wraps (fire-and-forget).
 * @param {{ db: import('@supabase/supabase-js').SupabaseClient, event: object, host: object, orgId: string }} args
 */
export async function notifyAdminsEventPublished({ db, event, host, orgId }) {
  const { profileIds } = await loadOrgAdmins(db, orgId)
  if (profileIds.length === 0) return

  // Push first, best-effort — a push hiccup never blocks the emails. The
  // registered host_event_review category (and its notify_host_event_review
  // switch and channel) is reused as is. Keyed on event+publish so a
  // republish after "take off sale" tells staff again; deduped per recipient.
  // data.type is NOT 'host_event_review': the phone opens the approvals inbox
  // for that type, and there is no card to decide any more.
  try {
    const { sendPushOnce } = await import('@/lib/push-dedup')
    await sendPushOnce(db, `host_event_published:${event.id}:${event.submitted_at || ''}`, profileIds, {
      title: 'Host event published',
      body: `${host.name || 'A host'} published "${event.name}". It is on sale now.`,
      category: 'host_event_review',
      data: { type: 'host_event_published', event_id: event.id },
    })
  } catch (e) {
    console.warn(`[host-notifications] publish push failed: ${e?.message || e}`)
  }

  const { data: profiles } = await db.from('profiles').select('email').in('id', profileIds)
  // Reuse the tested dedupe/lowercase/skip-empty pass (no host email here).
  const recipients = assembleHostRecipients({ email: null }, profiles || [])
  if (recipients.length === 0) return
  let publicBaseUrl = null
  try {
    publicBaseUrl = await resolveCustomerBaseUrl(db, host?.anchor_location_id || event?.location_id || null)
  } catch { publicBaseUrl = null }
  const msg = buildPublishedEmail({ event, host, appUrl: getAppUrl(), publicBaseUrl })
  for (const to of recipients) {
    await sendTransactionalEmail({
      to,
      subject: msg.subject,
      htmlBody: msg.htmlBody,
      locationId: event.location_id,
      tag: 'host-event-published',
    })
  }
}

// HOSTSTUDIONOTICE.1 — a published host event that starts to use a studio, or
// uses it for longer, is TOLD to staff (no check: the save already happened).
// Reasons come from studioUseGrew / studioHoursGrowth (src/lib/host-events.js).

const formatHold = (minutes) => {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return ''
  const h = Math.floor(m / 60)
  const r = m % 60
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`
}

/**
 * What changed, in words: "linked to Hatch Street", "moved from Stillorgan to
 * Hatch Street", "now starts earlier (first session 07:00) at Hatch Street".
 * Pure. Names only the event, the studios and times: no customer data.
 * @param {{ reasons: string[], growth?: { earlier?: string|null, later?: string|null, longerHoldMinutes?: number|null }|null, studioName?: string|null, previousStudioName?: string|null }} args
 * @returns {string}
 */
export function describeStudioChange({ reasons, growth, studioName, previousStudioName }) {
  const studio = studioName || 'a studio'
  const parts = []
  if ((reasons || []).includes('studio')) {
    parts.push(previousStudioName ? `moved from ${previousStudioName} to ${studio}` : `linked to ${studio}`)
  }
  if ((reasons || []).includes('studio_hours') && !(reasons || []).includes('studio')) {
    const g = growth || {}
    const hours = []
    if (g.earlier) hours.push(`starts earlier (first session ${g.earlier})`)
    if (g.later) hours.push(`runs later (last session ${g.later})`)
    if (g.longerHoldMinutes) hours.push(`holds the studio for longer (${formatHold(g.longerHoldMinutes)})`)
    const joined = hours.length > 1 ? `${hours.slice(0, -1).join(', ')} and ${hours[hours.length - 1]}` : (hours[0] || 'uses the studio for longer')
    parts.push(`now ${joined} at ${studio}`)
  }
  return parts.join('; ')
}

/**
 * Email to ORG ADMINS when a published host event's studio use grows. A
 * notice, nothing to approve; links the staff edit page (CRM host).
 * @param {{ event: { id: string, name: string }, host: { name?: string|null }, change: string, appUrl: string }} args
 * @returns {{ subject: string, htmlBody: string }}
 */
export function buildStudioChangeEmail({ event, host, change, appUrl }) {
  const hostName = escapeHtml(host?.name || 'A host')
  const eventName = escapeHtml(event?.name || 'an event')
  const staffUrl = `${appUrl}/events/${event?.id}/edit`
  return {
    subject: `Host event studio change: ${event?.name || 'an event'}`,
    htmlBody:
      `<p><strong>${hostName}</strong> changed <strong>${eventName}</strong>, which is on sale: it is ${escapeHtml(change)}.</p>` +
      `<p>The studio link keeps that studio's timers on for the event's sessions. Nothing needs your approval.</p>` +
      `<p>To check it, open it in the CRM: ` +
      `<a href="${escapeHtml(staffUrl)}">${escapeHtml(staffUrl)}</a></p>`,
  }
}

/**
 * Tell every org admin that a published host event now uses a studio, or uses
 * it for longer (HOSTSTUDIONOTICE.1). Informational. Studio names are read
 * from the org's own locations only. Throws on failure — caller wraps
 * (fire-and-forget).
 * @param {{ db: import('@supabase/supabase-js').SupabaseClient, event: { id: string, name: string, location_id?: string|null }, host: { name?: string|null }, orgId: string, reasons: string[], growth?: object|null, studioId: string, previousStudioId?: string|null, sessionTimes?: string[] }} args
 */
export async function notifyAdminsEventStudioChange({ db, event, host, orgId, reasons, growth = null, studioId, previousStudioId = null, sessionTimes = [] }) {
  if (!Array.isArray(reasons) || reasons.length === 0 || !studioId) return
  const { locations, profileIds } = await loadOrgAdmins(db, orgId)
  if (profileIds.length === 0) return
  const nameOf = (id) => locations.find((l) => l.id === id)?.name || null
  const change = describeStudioChange({
    reasons,
    growth,
    studioName: nameOf(studioId),
    previousStudioName: reasons.includes('studio') && previousStudioId ? nameOf(previousStudioId) || 'another studio' : null,
  })

  // Push first, best-effort, in the same registered category (and switch) as
  // the published notice. Keyed on the studio use the edit LEFT (studio, first
  // and last session, hold), so a replayed save does not push twice and a
  // further change pushes again.
  try {
    const times = [...sessionTimes].map((t) => String(t || '').slice(0, 5)).filter(Boolean).sort()
    const key = `host_event_studio:${event.id}:${studioId}:${times[0] || ''}-${times[times.length - 1] || ''}:${growth?.longerHoldMinutes || ''}`
    const { sendPushOnce } = await import('@/lib/push-dedup')
    await sendPushOnce(db, key, profileIds, {
      title: 'Host event studio change',
      body: `${host?.name || 'A host'} changed "${event.name}": ${change}.`,
      category: 'host_event_review',
      data: { type: 'host_event_studio_change', event_id: event.id },
    })
  } catch (e) {
    console.warn(`[host-notifications] studio-change push failed: ${e?.message || e}`)
  }

  const { data: profiles } = await db.from('profiles').select('email').in('id', profileIds)
  const recipients = assembleHostRecipients({ email: null }, profiles || [])
  if (recipients.length === 0) return
  const msg = buildStudioChangeEmail({ event, host, change, appUrl: getAppUrl() })
  for (const to of recipients) {
    await sendTransactionalEmail({
      to,
      subject: msg.subject,
      htmlBody: msg.htmlBody,
      locationId: event.location_id,
      tag: 'host-event-studio-change',
    })
  }
}
