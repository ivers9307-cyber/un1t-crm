'use client'

// APPROVALSQ.5 — the "Undo" beside a quiet clear's result. Renders nothing once
// the window (counted from `startedAt`) has closed. `onClick` is the owner's
// undo; the owner guards against a double press, `disabled` is only the look.

import { useUndoWindow } from '@/components/approvals/useUndoWindow'

export default function UndoClearButton({ startedAt, onClick, disabled = false }) {
  const open = useUndoWindow(startedAt)
  if (!open) return null
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 text-xs font-semibold underline underline-offset-2 disabled:opacity-50"
    >
      Undo
    </button>
  )
}
