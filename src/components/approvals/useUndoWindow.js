'use client'

// APPROVALSQ.5 — is a quiet clear still inside the window in which its author
// may undo it? `startedAtMs` is when the clear's answer reached this browser
// (or, for a bulk run, when the run finished), a few seconds after the server
// stamped `decided_at`, so the button can outlive the server's window by that
// much and the route then answers 409, which the card shows. It never closes
// early. Re-renders once, when the window ends; one timer, cleaned up on unmount.

import { useEffect, useState } from 'react'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

export function undoWindowOpen(startedAtMs, now = Date.now()) {
  return Number.isFinite(startedAtMs) && now - startedAtMs < UNDO_CLEAR_WINDOW_MS
}

export function useUndoWindow(startedAtMs) {
  // Bumped when the timer fires, so a timer that fires a millisecond early
  // re-arms itself instead of leaving the button up.
  const [tick, setTick] = useState(0)
  const open = undoWindowOpen(startedAtMs)
  useEffect(() => {
    if (!open) return undefined
    const left = Math.max(0, UNDO_CLEAR_WINDOW_MS - (Date.now() - startedAtMs))
    const timer = setTimeout(() => setTick((n) => n + 1), left)
    return () => clearTimeout(timer)
  }, [open, startedAtMs, tick])
  return open
}
