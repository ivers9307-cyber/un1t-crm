'use client'

// SegmentsGrid — card grid of every known tag with active count
// + per-channel deep-link broadcast hooks. Mig 085 / Phase 3.
//
// Each card has a "Send to these" link → /communications/send?segment=<tag>.
// The unified composer reads ?segment and pre-populates the AudienceBuilder with
// `{ field: 'tag', op: 'eq', value: <tag> }`, then the operator picks the channel
// (SMS / WhatsApp / email) there — no need to re-pick the audience.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, Tag, Send, Users } from 'lucide-react'

export default function SegmentsGrid() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/segments', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (!j.success) {
          setError(j.error || 'Failed to load segments')
        } else {
          setData(j.data)
        }
      })
      .catch(e => setError(e.message || 'Network error'))
  }, [])

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading segments…
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {data.map((s) => (
        <div
          key={s.tag}
          className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex flex-col"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Tag size={14} className="text-un1t-subtle" />
              <span className="text-sm font-mono text-un1t-text">{s.tag}</span>
            </div>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-un1t-border/40 text-un1t-subtle inline-flex items-center gap-1">
              <Users size={10} /> {s.count}
            </span>
          </div>
          <p className="text-xs text-un1t-subtle flex-1">{s.description}</p>
          <div className="mt-3 pt-3 border-t border-un1t-border flex items-center justify-between gap-2">
            <Link
              href={`/communications/send?segment=${encodeURIComponent(s.tag)}`}
              className="text-xs text-un1t-text hover:text-un1t-accent inline-flex items-center gap-1"
              title={`Send to ${s.tag} — pick SMS, WhatsApp or email`}
            >
              <Send size={11} /> Send to these
            </Link>
            <Link
              href={`/contacts?tag=${encodeURIComponent(s.tag)}`}
              className="text-xs text-un1t-subtle hover:text-un1t-text"
            >
              View contacts →
            </Link>
          </div>
        </div>
      ))}
      {data.length === 0 && (
        <div className="text-sm text-un1t-subtle italic px-2 py-8 text-center col-span-full">
          No segments defined yet. Tags appear here as they get assigned.
        </div>
      )}
    </div>
  )
}
