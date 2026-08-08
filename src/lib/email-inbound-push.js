// EMAIL-INBOUND-PUSH.1 — staff push when a member's email lands (2026-08-08
// audit P1: the WhatsApp and Instagram webhooks push on inbound; email never
// did, so the only way to learn about new mail was to be watching the queue).
//
// WHO IS PUSHED — exactly the people who could open the ticket, which is the
// read gate restated (loadTicketForUser / loadVisibleMailboxes):
//   • email_inbox resolved at the TICKET'S location (full tier order: the
//     location feature gate, the per-user override, the operator role
//     template, the code role default — same tiers hasPermissionForLocation
//     applies), AND
//   • a row in email_mailbox_access for the ticket's mailbox, OR elevated
//     (master, or owner at that location).
// A push carries the sender's name and subject line, so over-notifying IS the
// leak the mailbox grant model exists to prevent — which is also why a failed
// grant lookup drops the push entirely instead of degrading to "everyone at
// the location". Fail closed, like the read side.
//
// An OWNED ticket (email_tickets.assigned_to, write path since
// EMAIL-ASSIGN.1-2) narrows the fan-out to its owner alone — provided the
// owner still passes those same gates; otherwise the ticket is treated as
// unowned for notification purposes. See the inline comment in
// maybeNotifyInboundEmail.
//
// Deliberately NOT replicated from the read gate: SAAS-4 org admins (the
// synthetic owner role guardMasterOrOwner grants them). Same trade mig 502's
// RLS made — they hold no profile_locations row here to fan out from, and a
// missed courtesy push is recoverable in a way a leak is not.
//
// WHEN — one push per ticket per unseen burst, not one per message. The gate
// is the PRE-increment unread_count: 0 means this message is the one that
// makes the ticket unseen, so ping; >0 means an earlier ping is still
// outstanding and re-pinging per message is noise. The counter is zeroed by
// the …/read route when somebody actually opens the ticket, so the next
// message after that pings again. No timers, no extra state, and replay-safe:
// the webhook's own MessageID dedupe means a re-delivery never gets here, and
// the crash-reprocess path (finishDedupedDelivery) only pushes when the dead
// attempt provably never reached its own bump — which precedes the push.
//
// Our own outbound is never announced: mail FROM one of our mailbox addresses
// (compose from sales@ to accounts@, a member's reply-all echoing us) files
// normally but pushes nobody.
//
// Android note: FCM is still blocked on Firebase config (push audit 2026-07),
// so this lands iOS-first by construction — nothing here is platform-aware.

import { normalizeEmail } from './email-inbox'
import { sendPush } from './push'
import {
  resolvePermission,
  mergeTemplates,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
} from '@shared/permissions'

/**
 * Should this inbound message ping anyone at all?
 *
 * @param {{ fromEmail: string|null, ownAddresses: Array<string|null>, preUnreadCount: number }} args
 * @returns {boolean}
 */
export function shouldPushInboundEmail({ fromEmail, ownAddresses, preUnreadCount }) {
  if ((preUnreadCount || 0) > 0) return false
  const from = normalizeEmail(fromEmail)
  if (from) {
    for (const a of ownAddresses || []) {
      if (normalizeEmail(a) === from) return false
    }
  }
  return true
}

/**
 * The push recipient set — pure; the caller owns the queries.
 *
 * @param {object} args
 * @param {Array} args.links — profile_locations rows AT the ticket's location,
 *   each joined to its profile: { profile_id, role, permissions,
 *   profiles: { active, role, employment_type } }
 * @param {Array} args.templates — location_role_permissions rows at that
 *   location (empty/degraded ⇒ code defaults, matching resolvePushAllowedIds)
 * @param {object|null} args.features — locations.features, or null to skip
 *   the tier-1 gate (unknown ⇒ open, matching a null location in the resolver)
 * @param {string[]} args.grantedProfileIds — email_mailbox_access holders for
 *   the ticket's mailbox
 * @param {string|null} args.mailboxId — the TICKET'S mailbox; null (mig 484
 *   backfill / deleted mailbox) means no grant can exist ⇒ elevated only,
 *   matching loadTicketForUser
 * @returns {string[]} profile ids, deduplicated
 */
export function inboundEmailPushRecipients({ links, templates, features, grantedProfileIds, mailboxId }) {
  const granted = new Set(grantedProfileIds || [])
  const location = features ? { features } : null
  const rowFor = (role, emp) =>
    (templates || []).find(t => t.role === role && t.employment_type === emp)?.permissions || null

  const out = new Set()
  for (const l of links || []) {
    if (!l?.profiles?.active) continue
    const isMaster = l.profiles.role === 'master'
    const elevated = isMaster || l.role === 'owner'
    if (!elevated && !(mailboxId && granted.has(l.profile_id))) continue

    // Same tier order as hasPermissionForLocation, resolved per assignment:
    // the override blob and the merged template both carry web keys at top
    // level (mobile keys live under .mobile and are not in play here).
    const ok = resolvePermission({
      role: isMaster ? 'master' : l.role,
      location,
      permissions: l.permissions || {},
      roleTemplate: mergeTemplates(
        rowFor(l.role, 'all'),
        l.profiles.employment_type ? rowFor(l.role, l.profiles.employment_type) : null
      ),
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'email_inbox',
    })
    if (ok) out.add(l.profile_id)
  }
  return [...out]
}

/**
 * The sendPush payload. Category 'email' rides notify_email (registered in
 * shared/permissions — an unregistered category fails CLOSED for every role
 * but master); data.type routes the tap to the ticket thread on mobile
 * (notification-nav.js).
 */
export function inboundEmailPushPayload({ ticketId, requesterName, fromEmail, subject, preview }) {
  return {
    title: `Email · ${requesterName || fromEmail || 'New message'}`,
    body: (subject || preview || 'New email').substring(0, 140),
    category: 'email',
    data: { type: 'email_inbound', ticket_id: ticketId },
  }
}

/**
 * Gate, resolve, send. Never throws and never blocks the caller's outcome —
 * push is subordinate to filing the mail, same posture as the WhatsApp and
 * Instagram webhooks' fan-outs.
 *
 * @param {object} db — service-role client
 * @param {object} args — shouldPushInboundEmail's gate fields plus
 *   locationId / ticketId / ticketMailboxId and the payload fields
 */
export async function maybeNotifyInboundEmail(db, {
  locationId,
  ticketId,
  ticketMailboxId,
  fromEmail,
  ownAddresses,
  requesterName,
  subject,
  preview,
  preUnreadCount,
  assignedTo,
}) {
  try {
    if (!shouldPushInboundEmail({ fromEmail, ownAddresses, preUnreadCount })) return

    const [linksRes, tplRes, locRes, grantRes] = await Promise.all([
      db.from('profile_locations')
        .select('profile_id, role, permissions, profiles!inner(id, active, role, employment_type)')
        .eq('location_id', locationId),
      db.from('location_role_permissions')
        .select('role, employment_type, permissions')
        .eq('location_id', locationId),
      db.from('locations').select('features').eq('id', locationId).maybeSingle(),
      ticketMailboxId
        ? db.from('email_mailbox_access').select('profile_id').eq('mailbox_id', ticketMailboxId)
        : Promise.resolve({ data: [], error: null }),
    ])

    // Recipients and grants decide WHO — a failure in either means we cannot
    // know, and guessing over-notifies (the leak). Templates and features
    // only narrow; degrading them to code defaults mirrors resolvePushAllowedIds.
    if (linksRes.error || grantRes.error) {
      console.error('[email-inbound-push] recipient lookup failed — push dropped:',
        linksRes.error?.message || grantRes.error?.message)
      return
    }

    const ids = inboundEmailPushRecipients({
      links: linksRes.data || [],
      templates: tplRes.error ? [] : (tplRes.data || []),
      features: locRes.error ? null : (locRes.data?.features || null),
      grantedProfileIds: (grantRes.data || []).map(g => g.profile_id),
      mailboxId: ticketMailboxId || null,
    })
    if (!ids.length) return

    // EMAIL-PUSH-ASSIGNEE.1 — an owned ticket pings its owner alone (the
    // WhatsApp webhook's pattern), but ONLY when the owner still passes the
    // exact gates above: a claim is not a licence to keep receiving subject
    // lines after the grant, permission or membership behind it is revoked.
    // An assignee the gates refuse is treated as no assignee at all — the
    // stale owner gets nothing (the leak) AND the mail is still announced to
    // whoever can actually open it, rather than sitting unseen behind a
    // claim its holder cannot even read.
    const targets = assignedTo && ids.includes(assignedTo) ? [assignedTo] : ids

    // Per-user master switch + notify_email opt-out apply inside sendPush,
    // judged at this location (PUSH-LOC.1).
    await sendPush(targets, inboundEmailPushPayload({ ticketId, requesterName, fromEmail, subject, preview }), { locationId })
  } catch (err) {
    console.error('[email-inbound-push] push failed (email still filed)', err?.message)
  }
}
