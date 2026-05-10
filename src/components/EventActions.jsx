'use client'

import { useState } from 'react'
import { ExternalLink, Copy, Check, Trash2, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

export default function EventActions({ slug, eventId, eventName }) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState(null)

  const bookingUrl = `${window?.location?.origin || ''}/book/${slug}`
  const embedCode = `<iframe src="${bookingUrl}" style="width:100%;min-height:700px;border:none;" title="Book Now"></iframe>`

  function copyEmbed() {
    navigator.clipboard.writeText(embedCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // The DELETE API for booking types is a SOFT delete (sets
  // active=false). That preserves historical bookings linking back
  // to a meaningful name in reporting / contact timelines, while
  // hiding the type from the public booking page (`active=true`
  // filter on /api/public/bookings/[slug]). Operator can re-enable
  // by editing and toggling active back on.
  async function handleDelete() {
    if (!eventId) return
    setError(null)
    setDeleting(true)
    try {
      const r = await fetch(`/api/bookings/event-types/${eventId}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        throw new Error(j.error || `Delete failed (${r.status})`)
      }
      setConfirmOpen(false)
      router.refresh()
    } catch (e) {
      setError(e.message || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <a
          href={`/book/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors flex items-center gap-1.5"
        >
          <ExternalLink size={12} />
          Preview
        </a>
        <button
          onClick={copyEmbed}
          className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors flex items-center gap-1.5"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Embed'}
        </button>
        {eventId && (
          <button
            onClick={() => setConfirmOpen(true)}
            className="text-xs px-3 py-1.5 rounded border border-un1t-gray text-un1t-light hover:text-red-500 hover:border-red-500/40 transition-colors flex items-center gap-1.5"
            title="Hide this booking type from the public page (preserves history)"
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}
      </div>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => !deleting && setConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-un1t-dark border border-un1t-gray rounded-lg max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-un1t-white mb-2">
              Delete &ldquo;{eventName || 'this booking type'}&rdquo;?
            </h3>
            <p className="text-sm text-un1t-light mb-4">
              The booking type will be hidden from the public page so no new bookings can be made.
              Existing booking history is preserved — you can re-enable later by editing the type
              and toggling Active back on.
            </p>
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2 mb-3">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="text-xs px-3 py-2 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-xs px-3 py-2 rounded bg-red-500 hover:bg-red-600 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
