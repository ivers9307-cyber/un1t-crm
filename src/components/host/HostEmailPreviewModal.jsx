'use client'

// HOST-EMAILS.2 — "Preview as sent": the exact HTML a recipient's inbox gets
// (unsubscribe footer included), rendered in a fully sandboxed iframe so
// nothing in the design can run script or navigate the host portal.
//
// Extracted from HostEmails so the dialog owns its own dialog behaviour:
// Escape closes it, focus starts on Close, and the page behind it cannot
// scroll while it is open (restored on unmount).

import { useEffect, useRef } from 'react'

/**
 * @param {object}   props
 * @param {string}   props.html     sanitized preview HTML from /api/host/emails/preview
 * @param {number}   props.width    iframe width in px (375 mobile / 700 desktop)
 * @param {Function} props.onWidth  (next: number) => void
 * @param {Function} props.onClose  () => void
 */
export default function HostEmailPreviewModal({ html, width, onWidth, onClose }) {
  const closeRef = useRef(null)

  // Focus lands on Close so a keyboard user is inside the dialog, not still
  // on the page behind it.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Lock the page behind the dialog. Restore whatever was there before
  // rather than assuming '' so a nested/global lock is not clobbered.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Preview as sent">
      <div className="bg-[#111] border border-white/15 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
          <p className="text-sm text-white/70">This is what a recipient gets, including the unsubscribe footer.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onWidth(375)}
              aria-pressed={width === 375}
              className={`rounded px-2 py-1 text-xs ${width === 375 ? 'bg-white text-black' : 'text-white/60'}`}
            >
              Mobile
            </button>
            <button
              type="button"
              onClick={() => onWidth(700)}
              aria-pressed={width === 700}
              className={`rounded px-2 py-1 text-xs ${width === 700 ? 'bg-white text-black' : 'text-white/60'}`}
            >
              Desktop
            </button>
            <button ref={closeRef} type="button" onClick={onClose} className="text-xs text-white/60 hover:text-white px-2 py-1">Close</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-[#f4f4f5] flex justify-center p-4">
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={html}
            style={{ width, height: '75vh', border: 0, background: '#fff' }}
          />
        </div>
      </div>
    </div>
  )
}
