'use client'

// SavedSegmentChips — the saved segments (contact_segments) a send can start
// from, as chips, plus the "Using saved segment …" line once one is applied.
// Shared by the quick composer and the full campaign editor (EDITORRESEND.1).
// `segments` is null while loading (nothing shown), [] when there are none.
import Link from 'next/link'
import { Bookmark } from 'lucide-react'

export default function SavedSegmentChips({ segments, appliedSegmentId, onApply, onClear }) {
  if (segments === null) return null
  const applied = segments.find((s) => s.id === appliedSegmentId) || null
  return (
    <div>
      {segments.length === 0 ? (
        <p className="text-xs text-un1t-subtle">
          No saved segments yet. Build a filter on{' '}
          <Link href="/contacts" className="underline hover:text-un1t-text">Contacts</Link>{' '}
          and save it there — it shows up here for every send.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-un1t-subtle flex items-center gap-1">
            <Bookmark size={11} /> Saved segments
          </span>
          {segments.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onApply(s)}
              title={s.description || 'Apply this saved segment'}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                appliedSegmentId === s.id
                  ? 'border-un1t-text/30 bg-un1t-text/[0.06] text-un1t-text font-medium'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {applied && (
        <p className="mt-2 text-xs text-un1t-subtle flex flex-wrap items-center gap-1.5">
          <span>
            Using saved segment <b className="text-un1t-text">{applied.name}</b>. Editing the
            conditions below drops this — the segment itself is unchanged.
          </span>
          <button type="button" onClick={onClear} className="underline hover:text-un1t-text">
            Clear segment
          </button>
        </p>
      )}
    </div>
  )
}
