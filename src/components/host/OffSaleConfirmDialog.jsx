'use client'

// HOSTPORTAL.2 — "Take this event off sale?": the confirm step before a save
// that sends a published event back to review. A small modal on the
// host theme tokens (the scrim is dark in both themes). Escape and a click on the overlay mean
// "Keep editing"; focus starts on "Keep editing" (the safe choice).

import { useEffect, useId, useRef } from 'react'
import { RE_REVIEW_REASON_LABEL } from '@/lib/host-events'
import { HOST_PANEL, HOST_BTN, HOST_BTN_PRIMARY } from '@/components/host/host-ui'

// "A", "A or B", "A, B or C" (conjunction 'or' / 'and').
export function joinLabels(labels, conjunction) {
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} ${conjunction} ${labels[labels.length - 1]}`
}

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {string[]} props.reasons       keys of RE_REVIEW_REASON_LABEL
 * @param {string}   props.brandName
 * @param {boolean}  props.busy          the save is in flight
 * @param {Function} props.onConfirm     () => void
 * @param {Function} props.onKeepEditing () => void
 */
export default function OffSaleConfirmDialog({ open, reasons, brandName, busy, onConfirm, onKeepEditing }) {
  const titleId = useId()
  const keepRef = useRef(null)

  useEffect(() => {
    if (open) keepRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e) => { if (e.key === 'Escape') onKeepEditing() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onKeepEditing])

  if (!open) return null

  const labels = (reasons || []).map((r) => RE_REVIEW_REASON_LABEL[r]).filter(Boolean)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => { if (e.target === e.currentTarget) onKeepEditing() }}
    >
      <div className={`${HOST_PANEL} w-full max-w-md shadow-xl`}>
        <h2 id={titleId} className="text-base font-semibold text-host-text">Take this event off sale?</h2>
        <p className="mt-3 text-sm text-host-label">
          You changed {joinLabels(labels, 'and')}. Saving sends the event to {brandName} for review. Until it is approved the public page is offline and nobody can book. Existing bookings are kept.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <button
            ref={keepRef}
            type="button"
            onClick={onKeepEditing}
            className={HOST_BTN}
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={HOST_BTN_PRIMARY}
          >
            Save and send for review
          </button>
        </div>
      </div>
    </div>
  )
}
