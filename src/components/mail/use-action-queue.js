'use client'

// MAIL-HOOKS.1 — the Mail surface's serial action queue, extracted from
// MailSurface so the machinery (refs, tick, pending-target map, drain
// worker) lives behind one seam. The perform* callbacks stay in MailSurface:
// they close over conversations/selectedId/view state, and the drain effect
// below is keyed on them precisely so each queued item runs against the
// CURRENT render's snapshot of that state — see the worker's own comment.

import { useCallback, useEffect, useRef, useState } from 'react'

// TASK 2 — RAPID SINGLE ARCHIVES MUST NOT VANISH. The recorded decision
// against a multi-select/bulk toolbar stands — this only makes the single
// verb honest about what a rapid run of it does. Every verb below ENQUEUES;
// a single worker (the effect further down) drains the queue in order, one
// write at a time — click 5 fires exactly as reliably as click 1, it just
// waits its turn. Serial on purpose, not merely as a side effect of the fix:
// the IMAP write-back on the server is per-request sequential anyway, so two
// archives in flight at once would only risk the same
// overlapping-write-against-one-row hazard `actionSaving` always existed to
// prevent for a SINGLE row — queuing preserves that per row while no longer
// punishing every OTHER row for it.
//
// The queue's CONTENTS live in a ref (`actionQueueRef`), not state — pushing
// onto it must not itself trigger a render, the same reasoning as
// MailSurface's `listRequest`/`threadFor`. `queueTick` is a bare counter that
// exists solely to nudge the drain effect after an enqueue or a completed
// item.
export function useActionQueue({
  performArchive,
  performMarkUnread,
  performMarkRead,
  setActionSaving,
  setBusyId,
  mountedRef,
}) {
  const actionQueueRef = useRef([])
  const queueRunningRef = useRef(false)
  const [queueTick, setQueueTick] = useState(0)

  // CONTRACTS finding M3 — a per-row PENDING target, separate from the queue
  // itself. `archive(row, archived)` is always called with a boolean computed
  // by the CALLER from CURRENT list/pane state (`!isArchived(row)`), but that
  // state does not update until the archive's response returns — a
  // multi-second, sequential IMAP write. Two rapid `e` presses (or a keyboard
  // `e` racing a hover click on the same row) therefore both read the SAME
  // stale "not archived yet", both compute `true`, and the queue used to
  // faithfully execute "archive" twice — where the second keystroke plainly
  // MEANT "undo". This map holds what the row's target ALREADY IS once
  // something is pending/queued for it, so a second archive on the same row
  // toggles relative to THAT, not to stale list state — `e` `e` becomes a
  // real archive-then-unarchive. Cleared once nothing archive-shaped remains
  // queued for that row (see the drain effect's `finally`, below) — a click
  // AFTER everything has settled goes back to reading real list state, which
  // is correct again by then.
  const pendingArchiveRef = useRef(new Map())

  const enqueueAction = useCallback((type, row, args = {}) => {
    if (!row?.id) return
    actionQueueRef.current.push({ type, row, args })
    setQueueTick(t => t + 1)
  }, [])

  // The worker. Deliberately an EFFECT keyed on the perform* callbacks rather
  // than one long-lived async loop started on the first click: those
  // callbacks close over conversations/selectedId/viewId/debouncedQuery, and
  // a loop started on click 1 would keep running clicks 2 through 5 against
  // click 1's SNAPSHOT of that state — resolving conv-3's successor, say,
  // against a list that no longer has conv-1 or conv-2 in it. Re-deriving the
  // worker from the CURRENT render on every item instead means each queued
  // write sees the state as it stands right before its own turn, same as if
  // it had been clicked (and run immediately) at that moment.
  //
  // The perform trio + queueTick are the load-bearing dependencies; the
  // setters and mountedRef are identity-stable (useState setters, a useRef
  // box) and listed only so the dependency list stays honest.
  useEffect(() => {
    if (queueRunningRef.current) return
    const item = actionQueueRef.current[0]
    if (!item) return
    queueRunningRef.current = true
    setActionSaving(true)
    setBusyId(item.row.id)
    ;(async () => {
      try {
        if (item.type === 'archive') await performArchive(item.row, item.args.archived)
        else if (item.type === 'markUnread') await performMarkUnread(item.row)
        else if (item.type === 'markRead') await performMarkRead(item.row)
      } finally {
        // Popped either way — the array is a ref, not component state, so
        // mutating it after unmount is harmless; it is the setState calls
        // right below that must not run against a dead component.
        actionQueueRef.current.shift()
        queueRunningRef.current = false
        // CONTRACTS finding M3 — the pending-target map entry for THIS row
        // only clears once nothing archive-shaped remains queued for it. A
        // third rapid `e` (while the first is still in flight) enqueues a
        // second archive item before this one finishes — clearing here
        // unconditionally would let that second item's toggle read stale
        // list state again, the exact bug this map exists to prevent.
        if (item.type === 'archive' && item.row?.id) {
          const stillQueued = actionQueueRef.current.some(
            q => q.type === 'archive' && q.row?.id === item.row.id
          )
          if (!stillQueued) pendingArchiveRef.current.delete(item.row.id)
        }
        if (mountedRef.current) {
          setActionSaving(false)
          setBusyId(null)
          // Nudges this effect to check for a next item. Also covers the
          // "queue drains on unmount safely" requirement's other half: if the
          // component is gone, this never fires, so item 2 is never started
          // against it — see the queue-stops-on-unmount test.
          setQueueTick(t => t + 1)
        }
      }
    })()
  }, [queueTick, performArchive, performMarkUnread, performMarkRead, setActionSaving, setBusyId, mountedRef])

  const archive = useCallback((row, requestedArchived) => {
    if (!row?.id) return
    // CONTRACTS finding M3 — ignore the caller's boolean once something is
    // already pending/queued for this row; toggle relative to THAT instead.
    // See pendingArchiveRef's own comment, above.
    const target = pendingArchiveRef.current.has(row.id)
      ? !pendingArchiveRef.current.get(row.id)
      : requestedArchived
    pendingArchiveRef.current.set(row.id, target)
    enqueueAction('archive', row, { archived: target })
  }, [enqueueAction])

  const markUnreadAction = useCallback((row) => {
    enqueueAction('markUnread', row)
  }, [enqueueAction])

  const markReadAction = useCallback((row) => {
    enqueueAction('markRead', row)
  }, [enqueueAction])

  return { archive, markUnreadAction, markReadAction }
}
