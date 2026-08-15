// HOME.3 — the needs-attention queue: one assembler over the three surfaces
// an operator already checks separately (approvals, email tickets, the
// unified WhatsApp/Instagram inbox), merged into a single triage list.
//
// WHY THIS EXISTS
// Each surface already has its own count + list (getPendingApprovals,
// the ticket routes, the WA/IG unread-count route). This module does not
// re-implement any of them — it fans out to the SAME gates and, where a
// cheap true-count already exists, the SAME count queries, and merges the
// results into one sorted list. Two counters disagreeing about the same
// row is the failure this design avoids: it reuses, it does not re-derive.
//
// QueueRow = { source, sourceLabel, id, title, subtitle, occurredAt, href,
//              orgWide? }
//   `source` is the approvals provider key ('issues', 'host_events', …) for
//   an approvals row, or 'tickets' / 'inbox' for the other two. `orgWide` is
//   present (true) only for host_events — the one approval surface reviewed
//   across the caller's whole organisation rather than their active
//   location (see toApprovalRow below).
//
// CAPS
//   Each source is pre-capped to SOURCE_PRE_CAP rows (by occurredAt) before
//   the merge, so one noisy source can't crowd the other two off the list
//   entirely; the merged, sorted result is then capped to GLOBAL_CAP. Counts
//   are NEVER capped — `counts.<source>` is always the true, uncapped number
//   (reusing each surface's own count query), because a badge that reads
//   lower than the queue actually holding is the "click it, find nothing
//   behind it" trap this estate has hit before (email ticket badge, approvals
//   badge).
//
// GATES
//   Per-source gates mirror each surface's own count route exactly:
//     approvals → the registry's own per-provider isVisible/permissionKey
//                 gates (nothing extra here — see fetchApprovalsSource).
//     tickets   → hasPermissionForLocation(user, activeLocationId,
//                 'email_inbox') + per-account mailbox visibility
//                 (src/app/api/email/tickets/_helpers.js), same as
//                 /api/email/tickets/count.
//     inbox     → hasPermission(user, 'whatsapp'), same as
//                 /api/whatsapp/unread-count (one permission gates both
//                 WhatsApp and Instagram, as it does there).
//   No active location → the WHOLE queue is empty (not per-source): every
//   source here is location-scoped in practice (tickets and inbox always
//   are; approvals' one org-scoped provider, host_events, still requires an
//   active location to resolve the viewer's organisation), so there is
//   nothing a queue can show without one.
//
// FAILURE POSTURE
//   Each of the three sources is fetched via Promise.allSettled. A source
//   that throws degrades to an empty bucket (count 0, no rows) and its key
//   is listed in the returned `degraded` array — the same "one bad source
//   doesn't blank the whole surface" posture as getPendingApprovals. This
//   module never itself returns an HTTP error; the route decides whether an
//   all-sources-failed result is still a 200 with `degraded` or a 500.

import { getPendingApprovals, getPendingApprovalsCount } from '@/lib/approvals/registry'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { needsAction } from '@/lib/inbox-queues'
import {
  loadVisibleMailboxes,
  scopeToVisibleMailboxes,
  scopeToNeedsReply,
  scopeToUnmerged,
} from '@/app/api/email/tickets/_helpers'

export const SOURCE_PRE_CAP = 20
export const GLOBAL_CAP = 30

const SOURCE_NAMES = ['approvals', 'tickets', 'inbox']

function occurredAtMs(row) {
  const t = row?.occurredAt ? new Date(row.occurredAt).getTime() : NaN
  return Number.isFinite(t) ? t : 0
}

function byOccurredAtDesc(a, b) {
  return occurredAtMs(b) - occurredAtMs(a)
}

// ── Approvals ────────────────────────────────────────────────────────────

function toApprovalRow(provider, item) {
  const row = {
    source: provider.key,
    sourceLabel: provider.label,
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    occurredAt: item.submittedAt,
    href: item.reviewUrl,
  }
  // HOST-APPROVALS.1 — host_events is the one approval provider scoped to
  // the caller's ORGANISATION rather than their active location (a host's
  // event is reviewed by whichever studio owns the org, not "here"
  // specifically). Flagging it lets the queue UI badge it distinctly
  // instead of implying every row is local to the active studio — the same
  // decision the registry's own header docs make for that provider.
  if (provider.key === 'host_events') row.orgWide = true
  return row
}

async function fetchApprovalsSource(db, user) {
  const [{ providers }, count] = await Promise.all([
    getPendingApprovals(db, user),
    getPendingApprovalsCount(db, user),
  ])
  const rows = providers
    .flatMap((p) => (p.items || []).map((item) => toApprovalRow(p, item)))
    .sort(byOccurredAtDesc)
    .slice(0, SOURCE_PRE_CAP)
  return { rows, count }
}

// ── Tickets ──────────────────────────────────────────────────────────────

async function ticketsVisibility(db, user, locationId) {
  if (!hasPermissionForLocation(user, locationId, 'email_inbox')) return null
  const visibility = await loadVisibleMailboxes(db, user, locationId)
  if (visibility.response) {
    throw new Error('tickets: mailbox visibility lookup failed')
  }
  const { elevated, mailboxes } = visibility
  if (mailboxes.length === 0) return null
  return { elevated, mailboxes }
}

// Same three-scope stack (visible mailboxes → needs-reply → unmerged) as
// /api/email/tickets/count, applied in the same order, so the row list, the
// count and the nav badge can never disagree about which tickets qualify.
function applyTicketScope(query, vis) {
  return scopeToUnmerged(scopeToNeedsReply(scopeToVisibleMailboxes(query, vis)))
}

function toTicketRow(t) {
  return {
    source: 'tickets',
    sourceLabel: 'Tickets',
    id: t.id,
    title: t.subject || t.requester_name || t.requester_email || 'Ticket',
    subtitle: t.requester_name || t.requester_email || null,
    occurredAt: t.last_message_at,
    // TicketInbox holds no query-param deep link for a single ticket
    // (confirmed by reading src/components/tickets/TicketInbox.jsx,
    // 2026-08-15 — selection is client-only React state, set by clicking a
    // row). There is nothing to append here; this is a plain landing on
    // the queue, same as every other provider's reviewUrl would be without
    // a focus affordance on its target page.
    href: '/communications/tickets',
  }
}

async function fetchTicketsSource(db, user, locationId) {
  const vis = await ticketsVisibility(db, user, locationId)
  if (!vis) return { rows: [], count: 0 }

  const rowsQuery = applyTicketScope(
    db.from('email_tickets')
      .select('id, subject, requester_name, requester_email, last_message_at')
      .eq('location_id', locationId),
    vis
  ).order('last_message_at', { ascending: false, nullsFirst: false }).limit(SOURCE_PRE_CAP)

  const countQuery = applyTicketScope(
    db.from('email_tickets').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
    vis
  )

  const [{ data, error: rowsErr }, { count, error: countErr }] = await Promise.all([
    rowsQuery, countQuery,
  ])
  if (rowsErr) throw new Error(`tickets rows: ${rowsErr.message}`)
  if (countErr) throw new Error(`tickets count: ${countErr.message}`)

  // The query above already carries .limit(SOURCE_PRE_CAP); the slice is a
  // defence-in-depth backstop (cheap on an already-≤20 array) so the pre-cap
  // invariant holds even if a future edit drops the query-level limit.
  const rows = (data || []).slice(0, SOURCE_PRE_CAP).map(toTicketRow)
  return { rows, count: count || 0 }
}

async function countTicketsNeedsReply(db, user, locationId) {
  const vis = await ticketsVisibility(db, user, locationId)
  if (!vis) return 0
  const q = applyTicketScope(
    db.from('email_tickets').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
    vis
  )
  const { count, error } = await q
  if (error) throw new Error(`tickets count: ${error.message}`)
  return count || 0
}

// ── Inbox (WhatsApp + Instagram) ────────────────────────────────────────

const INBOX_COLUMNS =
  'id, resolved_at, last_message_at, last_message_direction, agent_handed_off_at, ' +
  'contacts!contact_id(id, name, first_name)'

function contactTitle(row, fallback) {
  const contact = row.contacts || null
  return contact?.name || contact?.first_name || fallback || 'Conversation'
}

function toInboxRow(row, channel) {
  const isIg = channel === 'ig'
  const fallback = isIg ? row.ig_username : row.wa_phone
  return {
    source: 'inbox',
    sourceLabel: isIg ? 'Instagram' : 'WhatsApp',
    id: row.id,
    title: contactTitle(row, fallback),
    subtitle: fallback || null,
    occurredAt: row.last_message_at,
    // UnifiedInbox deep links: ?c=<conversation_id> selects the thread,
    // ?ch=ig marks the channel (default wa) — confirmed in
    // src/app/communications/(hub)/inbox/page.js.
    href: isIg ? `/communications/inbox?c=${row.id}&ch=ig` : `/communications/inbox?c=${row.id}`,
  }
}

async function fetchNeedsActionConversations(db, locationId) {
  const [wa, ig] = await Promise.all([
    db.from('whatsapp_conversations')
      .select(`${INBOX_COLUMNS}, wa_phone`)
      .eq('location_id', locationId)
      .is('resolved_at', null),
    db.from('instagram_conversations')
      .select(`${INBOX_COLUMNS}, ig_username`)
      .eq('location_id', locationId)
      .is('resolved_at', null),
  ])
  if (wa.error) throw new Error(`inbox wa: ${wa.error.message}`)
  if (ig.error) throw new Error(`inbox ig: ${ig.error.message}`)

  const waRows = (wa.data || []).filter(needsAction).map((c) => toInboxRow(c, 'wa'))
  const igRows = (ig.data || []).filter(needsAction).map((c) => toInboxRow(c, 'ig'))
  return [...waRows, ...igRows]
}

async function fetchInboxSource(db, user, locationId) {
  if (!hasPermission(user, 'whatsapp')) return { rows: [], count: 0 }
  const all = await fetchNeedsActionConversations(db, locationId)
  const rows = [...all].sort(byOccurredAtDesc).slice(0, SOURCE_PRE_CAP)
  return { rows, count: all.length }
}

async function countInboxNeedsAction(db, user, locationId) {
  if (!hasPermission(user, 'whatsapp')) return 0
  const all = await fetchNeedsActionConversations(db, locationId)
  return all.length
}

// ── Assembler ────────────────────────────────────────────────────────────

/**
 * @param {object} db    service-role client
 * @param {object} user  getCurrentUser() result
 * @returns {Promise<{
 *   rows: object[],
 *   counts: { approvals: number, tickets: number, inbox: number },
 *   total: number,
 *   degraded?: string[],
 * }>}
 */
export async function assembleHomeQueue(db, user) {
  const locationId = user?.activeLocation?.id || null
  if (!locationId) {
    return { rows: [], counts: { approvals: 0, tickets: 0, inbox: 0 }, total: 0 }
  }

  const settled = await Promise.allSettled([
    fetchApprovalsSource(db, user),
    fetchTicketsSource(db, user, locationId),
    fetchInboxSource(db, user, locationId),
  ])

  const counts = {}
  const degraded = []
  let rows = []
  settled.forEach((s, i) => {
    const name = SOURCE_NAMES[i]
    if (s.status === 'fulfilled') {
      counts[name] = s.value.count
      rows = rows.concat(s.value.rows)
    } else {
      console.warn(`[home-queue] source '${name}' failed: ${s.reason?.message || s.reason}`)
      counts[name] = 0
      degraded.push(name)
    }
  })

  rows.sort(byOccurredAtDesc)
  rows = rows.slice(0, GLOBAL_CAP)

  const total = counts.approvals + counts.tickets + counts.inbox
  const result = { rows, counts, total }
  if (degraded.length) result.degraded = degraded
  return result
}

/**
 * Cheap count-only variant for the sidebar/nav badge — sums each source's
 * TRUE count without materialising any rows (no approval item lists, no
 * ticket subjects, no conversation contact embeds).
 *
 * @param {object} db
 * @param {object} user
 * @returns {Promise<number>}
 */
export async function getHomeQueueCount(db, user) {
  const locationId = user?.activeLocation?.id || null
  if (!locationId) return 0

  const settled = await Promise.allSettled([
    getPendingApprovalsCount(db, user),
    countTicketsNeedsReply(db, user, locationId),
    countInboxNeedsAction(db, user, locationId),
  ])
  return settled.reduce((sum, s) => sum + (s.status === 'fulfilled' ? (s.value || 0) : 0), 0)
}
