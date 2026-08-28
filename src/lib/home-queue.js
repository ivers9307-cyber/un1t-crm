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
  mailboxesForSurface,
  SURFACE_TICKETS,
  SURFACE_INBOX,
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

// EMAIL-TICKET-CLEANUP.2 — a FAILED mailbox-visibility lookup is NOT "no
// mailboxes" (mailboxesUnavailable() in _helpers.js exists precisely
// because the two used to collapse into the same empty answer). A generic
// tickets failure — the row/count query itself erroring — is allowed to
// fold into the ordinary degraded-source path (counts.tickets = 0, same as
// any other source); THIS failure is not, because "0" here reads as "no
// tickets need a reply" when the true answer is "we don't know". A
// dedicated error type lets assembleHomeQueue and getHomeQueueCount each
// catch this ONE case and answer honestly instead of a confident zero —
// see both call sites below.
class TicketsVisibilityUnavailableError extends Error {}

async function ticketsVisibility(db, user, locationId) {
  if (!hasPermissionForLocation(user, locationId, 'email_inbox')) return null
  const visibility = await loadVisibleMailboxes(db, user, locationId)
  if (visibility.response) {
    throw new TicketsVisibilityUnavailableError(
      'tickets: mailbox visibility lookup failed — EMAIL-TICKET-CLEANUP.2'
    )
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

/**
 * MAILBOX-SURFACE.1 — WHICH SURFACE LISTS THIS TICKET'S MAIL.
 *
 * The needs-reply predicate is identical on both surfaces, so this lane keeps
 * ONE query. What differs is where the operator has to go to answer it, and a
 * hard-coded '/communications/tickets' became a DEAD END the moment an account
 * moved: the row still appears here, the click lands on a queue that no longer
 * lists that mail, and the operator is left hunting for a member's question
 * they were just told about. That is the "where did my mail go" failure the
 * surface split exists to avoid, arriving through the back door.
 *
 * A NULL mailbox_id routes to tickets, matching the split's own rule: `surface`
 * DEFAULTS to 'tickets', and an orphan is exactly the case where nobody said
 * otherwise. It is also elevated-only and has always lived there, so nothing an
 * owner sees today moves.
 *
 * An UNKNOWN mailbox_id routes to tickets too. It cannot normally happen — the
 * ticket is scoped to visible mailboxes, so its mailbox is in this very map —
 * but "the surface I could not identify" must land somewhere real rather than
 * nowhere.
 */
function ticketSurface(mailboxId, surfaceById) {
  if (!mailboxId) return SURFACE_TICKETS
  return surfaceById.get(mailboxId) === SURFACE_INBOX ? SURFACE_INBOX : SURFACE_TICKETS
}

function toTicketRow(t, surfaceById) {
  const onMail = ticketSurface(t.mailbox_id, surfaceById) === SURFACE_INBOX
  return {
    // The SOURCE is what the row is grouped and labelled by, so a ticket whose
    // account moved reads as Mail here too. Labelling it 'Tickets' while
    // linking to Mail would be a different lie in the same place.
    source: onMail ? 'mail' : 'tickets',
    sourceLabel: onMail ? 'Mail' : 'Tickets',
    id: t.id,
    title: t.subject || t.requester_name || t.requester_email || 'Ticket',
    subtitle: t.requester_name || t.requester_email || null,
    occurredAt: t.last_message_at,
    // MAIL-DEEPLINK.1 — MailSurface.jsx now reads `?c=<id>` on mount and
    // selects + loads that conversation BY ID, even when it is not on page 1
    // of the list, so a mail row here can finally land the operator ON the
    // conversation this row named ("Sarah — needs reply") instead of at the
    // top of whichever view the inbox happens to be showing. TicketInbox
    // holds NO such deep link (confirmed by reading
    // src/components/tickets/TicketInbox.jsx, 2026-08-15 — selection there is
    // client-only React state, set by clicking a row), so the tickets half of
    // this ternary stays a plain landing on the queue, same as every other
    // provider's reviewUrl would be without a focus affordance on its target
    // page.
    href: onMail ? `/communications/mail?c=${t.id}` : '/communications/tickets',
  }
}

async function fetchTicketsSource(db, user, locationId) {
  const vis = await ticketsVisibility(db, user, locationId)
  if (!vis) return { rows: [], count: 0 }

  const rowsQuery = applyTicketScope(
    db.from('email_tickets')
      // mailbox_id rides along for MAILBOX-SURFACE.1 — a row has to know which
      // surface LISTS its mail before it can offer a link there.
      .select('id, subject, requester_name, requester_email, last_message_at, mailbox_id')
      .eq('location_id', locationId),
    vis
  ).order('last_message_at', { ascending: false, nullsFirst: false }).limit(SOURCE_PRE_CAP)

  // 🔴 TWO COUNTS, ONE PER SURFACE — because there are now two SECTIONS.
  // One combined number was correct only while one lane rendered it. Since the
  // rows split into a Tickets group and a Mail group, a single total put the
  // mail rows' count on the Tickets heading: a badge promising more than the
  // list under it holds, which is the red dot an operator clicks, finds nothing
  // behind, and afterwards ignores.
  //
  // The ORPHANS belong to exactly one of these, and only the ticket half may
  // claim them: applyTicketScope's elevated branch already widens to
  // `mailbox_id is null`, so reusing it for the mail half would count every
  // orphan TWICE and make the two sections add up to more than the queue holds.
  // The mail half is therefore scoped strictly to its own mailbox ids.
  const ticketsMailboxes = mailboxesForSurface(vis.mailboxes, SURFACE_TICKETS)
  const mailIds = mailboxesForSurface(vis.mailboxes, SURFACE_INBOX).map(m => m.id)

  const baseCount = () => db.from('email_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)

  const ticketsCountQuery = scopeToUnmerged(scopeToNeedsReply(
    scopeToVisibleMailboxes(baseCount(), { ...vis, mailboxes: ticketsMailboxes })
  ))
  const mailCountQuery = scopeToUnmerged(scopeToNeedsReply(
    baseCount().in('mailbox_id', mailIds)
  ))

  const [
    { data, error: rowsErr },
    { count, error: countErr },
    { count: mailCount, error: mailCountErr },
  ] = await Promise.all([rowsQuery, ticketsCountQuery, mailCountQuery])
  if (rowsErr) throw new Error(`tickets rows: ${rowsErr.message}`)
  if (countErr) throw new Error(`tickets count: ${countErr.message}`)
  if (mailCountErr) throw new Error(`mail count: ${mailCountErr.message}`)

  // The query above already carries .limit(SOURCE_PRE_CAP); the slice is a
  // defence-in-depth backstop (cheap on an already-≤20 array) so the pre-cap
  // invariant holds even if a future edit drops the query-level limit.
  // Built from the SAME visibility read the scope used, so the map can never
  // disagree with the rows about which mailboxes exist.
  const surfaceById = new Map((vis.mailboxes || []).map(m => [m.id, m.surface]))
  const rows = (data || []).slice(0, SOURCE_PRE_CAP).map(t => toTicketRow(t, surfaceById))
  return { rows, count: count || 0, mailCount: mailCount || 0 }
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
 *   counts: { approvals: number, tickets: number|null, inbox: number },
 *   total: number,
 *   degraded?: string[],
 * }>}
 */
export async function assembleHomeQueue(db, user) {
  const locationId = user?.activeLocation?.id || null
  if (!locationId) {
    return { rows: [], counts: { approvals: 0, tickets: 0, mail: 0, inbox: 0 }, total: 0 }
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
      // The tickets source answers for BOTH surfaces (one query, one visibility
      // read); `mail` is its second count rather than a fourth source, so the
      // two can never disagree about which mailboxes exist.
      if (name === 'tickets') counts.mail = s.value.mailCount ?? 0
      rows = rows.concat(s.value.rows)
    } else if (name === 'tickets' && s.reason instanceof TicketsVisibilityUnavailableError) {
      // EMAIL-TICKET-CLEANUP.2 — see the error class above: null, not 0.
      // "No tickets need a reply" and "we could not find out" must stay
      // distinguishable all the way to the response.
      console.warn(`[home-queue] source 'tickets' degraded: mailbox visibility lookup failed`)
      counts.tickets = null
      // Both surfaces read through the SAME visibility lookup, so when it fails
      // neither number is known. `mail` degrades to null for the same reason
      // and by the same rule: an unknown must never render as a confident 0.
      counts.mail = null
      degraded.push('tickets')
    } else {
      console.warn(`[home-queue] source '${name}' failed: ${s.reason?.message || s.reason}`)
      counts[name] = 0
      if (name === 'tickets') counts.mail = 0
      degraded.push(name)
    }
  })

  rows.sort(byOccurredAtDesc)
  rows = rows.slice(0, GLOBAL_CAP)

  // `null` (visibility-unavailable tickets) is excluded from the sum rather
  // than treated as 0 — the same reasoning as above applies to `total`: an
  // unknown contributor must not silently read as a known zero. The
  // `degraded` array is what tells a caller the total is a floor, not the
  // whole picture.
  const total = [counts.approvals, counts.tickets, counts.mail, counts.inbox]
    .filter((n) => typeof n === 'number')
    .reduce((sum, n) => sum + n, 0)
  const result = { rows, counts, total }
  if (degraded.length) result.degraded = degraded
  return result
}

/**
 * Cheap count-only variant for the sidebar/nav badge — sums each source's
 * TRUE count without materialising any rows (no approval item lists, no
 * ticket subjects, no conversation contact embeds).
 *
 * EMAIL-TICKET-CLEANUP.2 — this endpoint answers ONE number, with no room
 * for a per-source `degraded` flag the way assembleHomeQueue has, so a
 * failed mailbox-visibility lookup can't be folded into the sum as a
 * confident 0 the way a generic source failure is: it REJECTS instead,
 * mirroring /api/email/tickets/count's own 500 on the identical failure.
 * The route this feeds is expected to answer 500 on that rejection so its
 * poller keeps its last good number rather than overwriting it with a
 * wrong "nothing to do" (see src/app/api/home-queue/count/route.js).
 *
 * @param {object} db
 * @param {object} user
 * @returns {Promise<number>}
 */
// ── Rendering-adjacent helpers (pure) ───────────────────────────────────
// The Today page (src/app/dashboard/today/page.js) is a server component
// with no page-level test idiom in this repo, so the logic-worthy pieces
// of rendering the queue — the capped-count badge label and the
// group-or-flat decision — live here as pure functions with their own
// tests, and the page stays thin: call these, map the result to JSX.

/**
 * Badge text for the queue's SectionHeader: the true total, with a "+"
 * suffix appended when GLOBAL_CAP trimmed the row list below it — 42 real
 * items behind a 30-row list must read as "30+", never a confident "30".
 * Returns null (no badge) when there is nothing to count.
 *
 * FU-COSMETICS (c) — the "+" means "more rows exist below the ones shown"
 * everywhere else this label is used, which presumes at least SOME rows
 * are shown. When rowsCount is 0 but total isn't, that's not a capped
 * list — it's registry-internal degradation (a source's count came from a
 * query path independent of the one that materialised rows; see
 * src/lib/approvals/registry.js's countPending()-vs-fetchPending() split)
 * — nothing renders below the header at all. Dropping the "+" there stops
 * the header claiming a fuller list is one click away when the honest
 * story is "we have a count, but couldn't fetch what it counts"; the
 * caller pairs this with a subdued explanatory line (see
 * src/app/dashboard/today/page.js).
 */
export function queueCountLabel(total, rowsCount) {
  if (!total) return null
  if (rowsCount === 0) return String(total)
  return total > rowsCount ? `${total}+` : String(total)
}

// Which of the three top-level buckets (matching `counts` above) a row
// belongs to. Every approvals provider key (issues, invoices_queue,
// time_off, …) folds into 'approvals' — the queue's grouping and "View
// all" links are three-wide, matching `counts`, not one section per
// approval provider.
export function queueRowGroup(row) {
  if (row?.source === 'tickets') return 'tickets'
  // MAILBOX-SURFACE.1 — its own group, NOT 'inbox': that key is the unified
  // WhatsApp/Instagram queue at /communications/inbox, and folding email into
  // it would send the operator to the surface email deliberately left.
  if (row?.source === 'mail') return 'mail'
  if (row?.source === 'inbox') return 'inbox'
  return 'approvals'
}

const GROUP_META = {
  approvals: { label: 'Approvals', href: '/approvals' },
  tickets: { label: 'Tickets', href: '/communications/tickets' },
  mail: { label: 'Mail', href: '/communications/mail' },
  inbox: { label: 'Inbox', href: '/communications/inbox' },
}

/**
 * Split the merged row list into per-group sections when 3+ distinct
 * groups are present in it (order = first appearance in the
 * already-sorted rows, so the most recently active group leads); returns
 * null when 1-2 groups are present, telling the caller to render one flat
 * list instead — a single- or two-source queue doesn't need subheaders.
 * `counts` supplies each section's TRUE (uncapped) badge number; falls
 * back to the visible row count if a key is missing.
 */
export function groupQueueRows(rows, counts = {}) {
  const order = []
  const buckets = new Map()
  for (const row of rows || []) {
    const key = queueRowGroup(row)
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    buckets.get(key).push(row)
  }
  if (order.length < 3) return null
  return order.map((key) => ({
    key,
    label: GROUP_META[key].label,
    href: GROUP_META[key].href,
    count: typeof counts[key] === 'number' ? counts[key] : buckets.get(key).length,
    rows: buckets.get(key),
  }))
}

export async function getHomeQueueCount(db, user) {
  const locationId = user?.activeLocation?.id || null
  if (!locationId) return 0

  const settled = await Promise.allSettled([
    getPendingApprovalsCount(db, user),
    countTicketsNeedsReply(db, user, locationId),
    countInboxNeedsAction(db, user, locationId),
  ])

  const [, ticketsSettled] = settled
  if (ticketsSettled.status === 'rejected' && ticketsSettled.reason instanceof TicketsVisibilityUnavailableError) {
    throw ticketsSettled.reason
  }

  return settled.reduce((sum, s) => sum + (s.status === 'fulfilled' ? (s.value || 0) : 0), 0)
}
