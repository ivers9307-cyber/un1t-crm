// MAIL-REFINE.1 §03 — related conversations + merge, the mobile lib half.
//
// The thread screen shows a NUDGE when the same requester has other open
// conversations at this location, and a bottom-sheet PICKER that folds the
// selected ones into the thread being read. Everything either surface
// decides lives here where vitest reaches it; the screen reads verdicts.
//
// The server contract this is built to (pinned in CONTRACTS-REFINE.md —
// code to the contract, the route may land after this file):
//
//   GET /api/email/mail/[id]/related →
//     { success, data: { related: [{ id, subject, status, message_count,
//       last_message_at, requester_name }], open_count } }
//     Newest first, self excluded, capped at 10. Failure = a real error,
//     never an empty list.
//
//   POST   /api/email/mail/[R]/merge  { into: current }  — R merges in.
//   DELETE /api/email/mail/[R]/merge                     — un-merges R.
//
// THE RULE THAT MUST NOT BEND: an unknown count never renders as anything —
// not 0, not a banner. relatedNudge answers null for a count it cannot read,
// so the screen says nothing rather than something confident and wrong
// (the MAIL-ALLLOC.1 rule, one surface over).

import { isArchived } from 'shared/mail-vocabulary'
import { mailRowTime } from './mail-conversations'

// ── The nudge (§03 A) ────────────────────────────────────────────────
/**
 * What the banner under the thread header says, or null for "show nothing".
 *
 * Null when: no data, open_count unreadable (see the header — unknown is not
 * zero, and it is not a banner either), or open_count < 1.
 *
 * `viewId` is the id the View link opens: the NEWEST OPEN related thread
 * (the list is newest first; archived rows are skipped). MAIL-ARCH.3/4 —
 * "archived" is the SERVER'S stamp on each candidate, read through shared's
 * isArchived: a legacy `solved` row the server stamps LIVE is open
 * here exactly as it is on the web, where it used to be skipped because
 * this file read `status`. It can be null while the banner still shows: the
 * list is capped, so the open rows may not all be on it. The screen hides
 * the View link then and keeps Merge.
 *
 * `chip` (MAIL-READER.M1) is the same verdict in a header chip's width, not
 * the banner's sentence: "Jordan Sample has 2 other open conversations"
 * does not fit next to a status chip.
 *
 * 🔴 IT COUNTS `open_count`, THE SAME NUMBER `text` COUNTS. It was written
 * counting the open rows in `related` instead, on the reasoning that
 * `related` is capped at 10 and can hold archived rows, so the chip should
 * only promise what a tap can back up. That reasoning is wrong here, and the
 * fix is worth recording: the chip and the sentence are the SAME verdict at
 * two widths, and the sheet the chip opens shows the sentence. Counting them
 * separately let a chip read "1 other" directly above a sheet saying "has 3
 * other open conversations" — two counters for one fact, the shape this
 * estate has already been bitten by. The cap is real, and it is why `viewId`
 * can be null while the chip still shows a count; that is handled by hiding
 * the View link, not by disagreeing about the number.
 *
 * @param {{related?: object[], open_count?: number}|null} data
 * @returns {null|{ name: string, count: number, text: string, chip: string, viewId: string|null }}
 */
export function relatedNudge(data) {
  if (!data) return null
  const count = Number(data.open_count)
  if (!Number.isFinite(count) || data.open_count == null || count < 1) return null
  const related = Array.isArray(data.related) ? data.related : []
  const name = related[0]?.requester_name || 'This sender'
  const openRelated = related.filter(r => r?.id && !isArchived(r))
  const newestOpen = openRelated[0]
  return {
    name,
    count,
    text: `${name} has ${count} other open conversation${count === 1 ? '' : 's'}`,
    // 🔴 THE SAME `count` THE SENTENCE USES, never openRelated.length. The
    // chip is a shorter way to say the sentence, not a second measurement:
    // `related` is a capped, archived-inclusive window, so counting it here
    // would let the chip read "1 other" above a sheet saying "has 3 other
    // open conversations" — two counters for one fact, which is how a badge
    // ends up pointing at a list that does not match it.
    chip: `${count} other${count === 1 ? '' : 's'}`,
    viewId: newestOpen?.id || null,
  }
}

// ── The picker (§03 B) ───────────────────────────────────────────────
/**
 * The merge sheet's rows — ALL related, open and archived both (the
 * contract), each with the mockup's detail line: who · how many messages ·
 * state + when. Rows without an id are dropped: they cannot be merged,
 * keyed, or deduped.
 *
 * The message count is OMITTED when the server sent none rather than
 * claimed as 0 — the same never-confidently-zero posture as the nudge.
 */
export function mergePickerRows(related, now = new Date()) {
  return (Array.isArray(related) ? related : [])
    .filter(r => r?.id)
    .map(r => ({
      id: r.id,
      subject: r.subject || '(no subject)',
      archived: isArchived(r),
      detail: relatedRowDetail(r, now),
    }))
}

function relatedRowDetail(r, now) {
  const n = Number(r.message_count)
  const messages = Number.isFinite(n) && n > 0
    ? `${n} message${n === 1 ? '' : 's'}`
    : null
  const when = mailRowTime(r.last_message_at, now)
  const state = isArchived(r) ? 'archived' : 'active'
  return [
    r.requester_name || null,
    messages,
    when ? `${state} ${when}` : state,
  ].filter(Boolean).join(' · ')
}

/**
 * The confirm button: named counts per the mockup ("Merge 1 conversation"),
 * disabled until something is selected. Garbage counts as nothing selected —
 * a disabled button is the safe wrong answer.
 */
export function mergeButtonLabel(selectedCount) {
  const n = Number(selectedCount)
  if (!Number.isFinite(n) || n < 1) return { label: 'Merge', disabled: true }
  return { label: `Merge ${n} conversation${n === 1 ? '' : 's'}`, disabled: false }
}

/** Checkbox toggle over a Set, pure — the input set is never mutated
 * (React state identity is how the sheet re-renders). */
export function toggleId(set, id) {
  const next = new Set(set || [])
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// ── Running the merges (§03 confirm) ─────────────────────────────────
/**
 * Merge the selected conversations ONE AT A TIME, in order, stopping on the
 * first failure — a failed merge must never look merged, and a parallel
 * fan-out could not say which ones landed.
 *
 * `mergeFn(id)` is the wrapper call (its envelope passes through: a thrown
 * fn and a { success: false } answer are the same fact). The result names
 * every id that DID merge (they really moved — the caller refreshes and may
 * offer Undo over exactly this list) and the one that failed, with its
 * sentence, or `failed: null` on a clean run.
 *
 * @param {string[]} ids
 * @param {(id: string) => Promise<{success?: boolean, error?: string}>} mergeFn
 * @returns {Promise<{ merged: string[], failed: null|{ id: string, error: string } }>}
 */
export async function runMerges(ids, mergeFn) {
  const merged = []
  for (const id of Array.isArray(ids) ? ids : []) {
    let res
    try {
      res = await mergeFn(id)
    } catch (err) {
      res = { success: false, error: err?.message || String(err) }
    }
    if (res?.success !== true) {
      return { merged, failed: { id, error: res?.error || 'That conversation could not be merged.' } }
    }
    merged.push(id)
  }
  return { merged, failed: null }
}

/** The success notice that carries the Undo — counts what actually merged. */
export function mergeUndoNotice(mergedCount) {
  const n = Number(mergedCount) || 0
  return {
    title: 'Merged',
    message: `${n} conversation${n === 1 ? ' was' : 's were'} merged into this one.`,
  }
}
