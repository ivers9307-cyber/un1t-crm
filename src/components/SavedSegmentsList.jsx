'use client'

// SEGPICK.1 — the operator's OWN saved audience filters (contact_segments,
// saved from the advanced filter on /contacts), listed on the Segments tab
// beside the hardcoded machine tag cards in SegmentsGrid.
//
// Two deliberately different things share the word "segment" here:
//   · tag cards (SegmentsGrid) → /communications/send?segment=<tag>
//   · these saved filters      → /communications/send?segment_id=<uuid>
// The composer applies a saved filter wholesale; the tag link seeds one
// clause. Keeping the groups visually separate is the point — see the
// 2026-08-09 comms audit, where operators could not tell which was which.
//
// Membership is LIVE: the row stores a filter, not a frozen list of people,
// and it is re-evaluated every time it drives a send. Nothing in this product
// said so until now.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, Bookmark, Send } from 'lucide-react'

export default function SavedSegmentsList({ locationId }) {
  const [segments, setSegments] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/contacts/segments?location_id=${encodeURIComponent(locationId)}`, { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        if (!json?.success) setError(json?.error || 'Failed to load saved segments')
        else setSegments(json.segments || [])
      } catch (e) {
        if (alive) setError(e?.message || 'Network error')
      }
    })()
    return () => { alive = false }
  }, [locationId])

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (segments === null) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading saved segments…
      </div>
    )
  }
  if (segments.length === 0) {
    return (
      <p className="text-sm text-un1t-subtle">
        No saved segments yet. Build a filter on{' '}
        <Link href="/contacts" className="underline hover:text-un1t-text">Contacts</Link>{' '}
        and save it there — it appears here and in the composer for every send.
      </p>
    )
  }

  return (
    <>
      <p className="text-sm text-un1t-subtle mb-3">
        Your own saved filters from Contacts. Membership is live — each one stores a filter, not a
        frozen list of people, and it is re-run against the current contacts every time you send.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {segments.map(s => (
          <div key={s.id} className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <Bookmark size={14} className="text-un1t-subtle" />
              <span className="text-sm font-medium text-un1t-text">{s.name}</span>
            </div>
            <p className="text-xs text-un1t-subtle flex-1">
              {s.description || 'Saved filter — no description.'}
            </p>
            <div className="mt-3 pt-3 border-t border-un1t-border">
              <Link
                href={`/communications/send?segment_id=${encodeURIComponent(s.id)}`}
                className="text-xs text-un1t-text hover:text-un1t-accent inline-flex items-center gap-1"
                title={`Send to ${s.name} — pick SMS, WhatsApp or email`}
              >
                <Send size={11} /> Send to these
              </Link>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
