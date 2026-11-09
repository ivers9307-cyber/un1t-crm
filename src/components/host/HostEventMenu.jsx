'use client'

// The "⋯" more-actions menu in the host event header (HOSTPORTAL.2): the
// existing Take off sale / Delete actions, tucked behind one button. Closes on
// Escape and on a press outside.

import { useEffect, useRef, useState } from 'react'
import HostEventActions, { hasHostEventActions } from '@/components/host/HostEventActions'

export default function HostEventMenu({ eventId, status, hasRegistrations, brandName }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onPress = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPress)
    }
  }, [open])

  if (!hasHostEventActions({ status, hasRegistrations })) return null

  // Below sm the panel anchors to the header's actions row (which is `relative`
  // and full width there), so it opens at the left edge and stays on screen
  // wherever the ⋯ button wrapped to; from sm it hangs off the button's right.
  return (
    <div ref={root} className="sm:relative">
      <button
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-white/15 text-white/80 text-sm px-3 py-2 hover:bg-white/5"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute left-0 sm:left-auto sm:right-0 z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-white/15 bg-black p-3 shadow-xl">
          <HostEventActions eventId={eventId} status={status} hasRegistrations={hasRegistrations} brandName={brandName} />
        </div>
      )}
    </div>
  )
}
