// MAIL-REFINE.1 (03) — relating conversations: the pure half.
//
// Mail's answer to "this member has two threads about one thing": a nudge in
// the reading pane when the same requester has other OPEN conversations, and a
// picker that folds any of them (open or archived) into the one on screen via
// the existing merge machinery. Everything decidable without a DOM lives here;
// MailThread only renders these answers and owns the fetch lifecycle.
//
// THE SERVER CONTRACT (pinned; the route may land after this file):
//   GET /api/email/mail/[id]/related →
//     { success, data: { related: [{ id, subject, status, message_count,
//        last_message_at, requester_name }], open_count } }
//   newest first, capped at 10, same requester + location, caller-visible
//   mailboxes only, unmerged, self excluded. Failure is a REAL error — the
//   route never answers an empty list for "could not look".
//   Merge / unmerge: POST / DELETE /api/email/tickets/[id]/merge ({into} on
//   POST) — both pre-existing; called, never re-implemented.
//
// 🔴 TWO RULES, mirrored in the tests:
//   • a failed related READ must never render as "no related conversations" —
//     parseRelated answers null for anything it cannot vouch for, and null
//     means "render nothing", never "render zero";
//   • a failed MERGE must never look merged — the executor is sequential,
//     stops at the first failure, and reports exactly which ids succeeded so
//     the caller can refresh honestly (the ones that merged really did merge).

import { relativeTime } from '@/lib/ticket-display'
// MAIL-ARCH.4 — the related route stamps `archived` (MAIL-ARCH.3); read the
// stamp through the shared vocabulary, never `status`, so a legacy `solved`
// row the server calls LIVE is open here exactly as it is on the phone.
import { isArchived } from './mail-vocabulary'

/** The pinned related route for one conversation. */
export function relatedUrl(conversationId) {
  return `/api/email/mail/${encodeURIComponent(conversationId)}/related`
}

/**
 * The parsed related answer, or null.
 *
 * Null covers every shape this function cannot vouch for — a failed response,
 * missing data, a non-array list. The caller renders NOTHING for null: "we do
 * not know" must never wear "there are none"'s clothes, which is the same
 * honesty rule the route itself carries ("failure = real error, never an
 * empty list"), applied to the half the client can check.
 *
 * Entries with no id are dropped rather than rendered: a related row exists on
 * screen only to be opened or merged, and both need the id.
 */
export function parseRelated(body) {
  if (!body?.success || !body.data || !Array.isArray(body.data.related)) return null
  return {
    related: body.data.related.filter(r => r && r.id),
    // A count this function cannot read as a number is an unknown, and an
    // unknown must never nudge (the same never-render-an-unknown-as-0 rule the
    // All-mode digest carries).
    openCount: Number.isFinite(body.data.open_count) ? body.data.open_count : 0,
  }
}

/**
 * Open on this surface means "not archived". THE SERVER'S STAMP IS THE ANSWER:
 * the related route stamps `archived` on every row (stampMailRow, MAIL-ARCH.3)
 * and isArchived reads it, falling back to the `closed` status only for a
 * stampless fixture — which is the same predicate the server used, so the two
 * readings cannot disagree. Before MAIL-ARCH.4 this compared `status` directly;
 * it happened to agree with the stamp on every row, but it was a second
 * derivation of a fact the server had already decided, and the phone's twin of
 * this line (mobile/lib/mail-relate.js) had drifted from it once.
 */
export function isOpenRelated(item) {
  return !!item && !isArchived(item)
}

/**
 * The conversation "View" opens: the newest OPEN related thread. The route
 * answers newest-first, so this is the first open entry — never an archived
 * one, which the nudge is not about.
 */
export function newestOpenRelated(related) {
  if (!Array.isArray(related)) return null
  return related.find(isOpenRelated) || null
}

/**
 * The nudge banner's content, or null when no banner is earned.
 *
 * Earned only by an OPEN related conversation (openCount ≥ 1): archived
 * relatives are reachable through the picker but do not interrupt reading.
 * A null parse (failed read) never nudges — see parseRelated.
 */
export function relatedNudge(parsed, requesterName) {
  if (!parsed || !(parsed.openCount >= 1)) return null
  const count = parsed.openCount
  return {
    name: requesterName || 'This sender',
    count,
    label: `${count} other open conversation${count === 1 ? '' : 's'}`,
    viewId: newestOpenRelated(parsed.related)?.id || null,
  }
}

/**
 * One picker row's description: "Caitlin Thornton · 2 messages · opened 3d"
 * (or "… · archived 12 Aug"). "Archived", never "closed" — one lifecycle, two
 * vocabularies, and the operator only ever reads this one. Missing facts are
 * omitted rather than rendered as placeholders.
 */
export function candidateLine(item, now = Date.now()) {
  const parts = [item?.requester_name || 'Unknown sender']
  const count = item?.message_count
  if (Number.isFinite(count)) parts.push(`${count} message${count === 1 ? '' : 's'}`)
  const verb = isArchived(item) ? 'archived' : 'opened'
  const when = relativeTime(item?.last_message_at, now)
  parts.push(when ? `${verb} ${when}` : verb)
  return parts.join(' · ')
}

/** The confirm button says what it is about to do, counted. */
export function mergeButtonLabel(count) {
  if (!count) return 'Merge'
  return `Merge ${count} conversation${count === 1 ? '' : 's'}`
}

// One attempt against the merge route, judged the only honest way: HTTP ok AND
// the body's own success flag. An unreadable body proves nothing and counts as
// failure; a thrown fetch is a failure, not an exception the picker crashes on.
async function attempt(url, init, fetchImpl, fallbackError) {
  try {
    const res = await fetchImpl(url, init)
    let body = null
    try { body = await res.json() } catch { body = null }
    if (res.ok && body?.success) return null
    return body?.error || fallbackError
  } catch {
    return `${fallbackError} — check your connection and try again`
  }
}

/**
 * Merge each id into `into`, SEQUENTIALLY, stopping at the first failure.
 *
 * Sequential because the contract says so and because it is what makes the
 * result reportable: `merged` is exactly the ids whose merge the server
 * confirmed, `failed` names the one that broke (with the server's own words),
 * and everything after it was never attempted. A failed merge must never look
 * merged — so there is no Promise.all here, ever.
 *
 * @returns {Promise<{ merged: string[], failed: null | { id: string, error: string } }>}
 */
export async function mergeConversations({ ids = [], into, fetchImpl = globalThis.fetch }) {
  const merged = []
  for (const id of ids) {
    const error = await attempt(
      `/api/email/tickets/${encodeURIComponent(id)}/merge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into }),
      },
      fetchImpl,
      'Could not merge that conversation'
    )
    if (error) return { merged, failed: { id, error } }
    merged.push(id)
  }
  return { merged, failed: null }
}

/**
 * The toast's Undo: un-merge each id, same sequential stop-on-failure shape.
 * `unmerged` is what genuinely came back; `failed` names what did not, so the
 * toast can say the truth rather than "undone" over a half-done undo.
 */
export async function unmergeConversations({ ids = [], fetchImpl = globalThis.fetch }) {
  const unmerged = []
  for (const id of ids) {
    const error = await attempt(
      `/api/email/tickets/${encodeURIComponent(id)}/merge`,
      { method: 'DELETE' },
      fetchImpl,
      'Could not undo that merge'
    )
    if (error) return { unmerged, failed: { id, error } }
    unmerged.push(id)
  }
  return { unmerged, failed: null }
}
