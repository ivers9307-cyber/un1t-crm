'use client'

// Reusable sequence picker — used by every "Add to sequence" affordance:
//   - ContactActions  (single contact, popover)
//   - DealCard menu   (single contact via the deal's contact_id, popover)
//   - ContactsTable   (bulk select, modal)
//
// Props:
//   contactIds : string[]   — one or more contact UUIDs to enrol
//   locationId : string     — the active location's UUID (for filtering sequences)
//   variant    : 'popover' | 'modal'  — controls width + max-height. Default popover.
//   onClose    : () => void — called when user dismisses or after success
//   onSuccess  : ({ enrolled, skipped, ignored_invalid, sequence }) => void — optional toast hook
//
// Behaviour:
//   - Fetches /api/sequences?location_id=X on mount (no caching — sequence list
//     changes infrequently but is cheap enough to refetch each open).
//   - Lists every sequence with status='active', regardless of trigger_type, with
//     a small badge telling the operator what the trigger usually is. Manual
//     sequences are the obvious enrol target; the others are still usable when
//     you need to push someone into an automated flow ad-hoc.
//   - On click, POSTs to /api/sequences/[id]/enrol. The endpoint dedupes
//     already-enrolled contacts (UNIQUE partial idx on (sequence_id, contact_id)
//     where status='active') so this is idempotent.

import { useEffect, useState } from 'react'
import { Mail, Calendar, MessageSquare, RefreshCw, Tag, Zap, AlertCircle, Check } from 'lucide-react'

const TRIGGER_META = {
  manual:           { label: 'Manual',          icon: Zap,            cls: 'bg-blue-500/20 text-blue-400' },
  booking_created:  { label: 'Booking',         icon: Calendar,       cls: 'bg-purple-500/20 text-purple-400' },
  status_change:    { label: 'Status change',   icon: RefreshCw,      cls: 'bg-amber-500/20 text-amber-400' },
  event_reminder:   { label: 'Event reminder',  icon: Calendar,       cls: 'bg-emerald-500/20 text-emerald-400' },
  tag_added:        { label: 'Tag',             icon: Tag,            cls: 'bg-pink-500/20 text-pink-400' },
}

export default function SequencePicker({ contactIds, locationId, variant = 'popover', onClose, onSuccess }) {
  const [sequences, setSequences] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [enrollingId, setEnrollingId] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/sequences?location_id=${encodeURIComponent(locationId)}`)
        const json = await res.json()
        if (cancelled) return
        if (!json.success) {
          setLoadError(json.error || 'Failed to load sequences')
          return
        }
        // Show only active sequences. Drafts/paused/archived shouldn't be
        // enrol targets — there's no live runner to pick them up.
        const active = (json.sequences || []).filter(s => s.status === 'active')
        // Order: manual first (the most common enrol target), then by name.
        active.sort((a, b) => {
          if (a.trigger_type === 'manual' && b.trigger_type !== 'manual') return -1
          if (b.trigger_type === 'manual' && a.trigger_type !== 'manual') return 1
          return a.name.localeCompare(b.name)
        })
        setSequences(active)
      } catch (e) {
        if (!cancelled) setLoadError(e.message || 'Network error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  async function enrol(sequence) {
    setEnrollingId(sequence.id)
    setResult(null)
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: contactIds, source_ref: 'ui' }),
      })
      const json = await res.json()
      if (!json.success) {
        setResult({ error: json.error || 'Enrol failed' })
        return
      }
      const summary = {
        enrolled: json.enrolled ?? 0,
        skipped: json.skipped ?? 0,
        ignored_invalid: json.ignored_invalid ?? 0,
        sequence,
      }
      setResult(summary)
      onSuccess?.(summary)
    } catch (e) {
      setResult({ error: e.message || 'Network error' })
    } finally {
      setEnrollingId(null)
    }
  }

  const widthCls = variant === 'modal' ? 'w-full max-w-lg' : 'w-80'
  const maxHCls = variant === 'modal' ? 'max-h-[70vh]' : 'max-h-96'

  return (
    <div className={`bg-un1t-dark border border-un1t-gray rounded-lg p-4 shadow-lg ${widthCls}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Mail size={14} className="text-un1t-light" />
          <span className="text-sm font-semibold text-un1t-white">
            Add to sequence
          </span>
          <span className="text-xs text-un1t-light">
            ({contactIds.length} contact{contactIds.length === 1 ? '' : 's'})
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-xs text-un1t-light hover:text-un1t-white">
            ✕
          </button>
        )}
      </div>

      {result && !result.error && (
        <div className="mb-3 p-2 rounded bg-green-500/10 border border-green-500/30 text-xs text-green-400 flex items-start gap-2">
          <Check size={12} className="shrink-0 mt-0.5" />
          <div>
            Added to <span className="font-semibold">{result.sequence.name}</span>:
            {' '}{result.enrolled} enrolled
            {result.skipped > 0 && `, ${result.skipped} already active`}
            {result.ignored_invalid > 0 && `, ${result.ignored_invalid} not at this location`}.
          </div>
        </div>
      )}

      {result?.error && (
        <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <div>{result.error}</div>
        </div>
      )}

      {loadError && (
        <div className="text-xs text-red-400 py-2">{loadError}</div>
      )}

      {!loadError && sequences === null && (
        <div className="text-xs text-un1t-light py-2">Loading sequences…</div>
      )}

      {sequences && sequences.length === 0 && (
        <div className="text-xs text-un1t-light py-2">
          No active sequences at this location.
          <br />
          <a href="/communications/sequences" className="text-blue-400 hover:underline">
            Create one →
          </a>
        </div>
      )}

      {sequences && sequences.length > 0 && (
        <div className={`space-y-1.5 overflow-y-auto ${maxHCls}`}>
          {sequences.map(s => {
            const meta = TRIGGER_META[s.trigger_type] || {
              label: s.trigger_type, icon: MessageSquare, cls: 'bg-un1t-gray/40 text-un1t-light',
            }
            const Icon = meta.icon
            const isEnrolling = enrollingId === s.id
            return (
              <button
                key={s.id}
                onClick={() => enrol(s)}
                disabled={enrollingId !== null}
                className="w-full text-left p-2.5 rounded border border-un1t-gray hover:border-un1t-mid hover:bg-un1t-gray/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-un1t-white truncate">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-un1t-light line-clamp-2 mt-0.5">{s.description}</div>
                    )}
                  </div>
                  <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded inline-flex items-center gap-1 shrink-0 ${meta.cls}`}>
                    <Icon size={10} />
                    {meta.label}
                  </span>
                </div>
                {isEnrolling && (
                  <div className="text-[10px] text-un1t-light mt-1">Enrolling…</div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
