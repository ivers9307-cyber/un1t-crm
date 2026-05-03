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
import { Mail, Calendar, MessageSquare, RefreshCw, Tag, Zap, AlertCircle, Check, ChevronLeft, Loader2 } from 'lucide-react'

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
  // Two-step flow:
  //   step='picking'  — list of sequences, click one to fetch preview
  //   step='preview'  — preview screen with Confirm / Back
  //   step='done'     — success state showing the enrol summary
  const [step, setStep] = useState('picking')
  const [busy, setBusy] = useState(false)
  const [selectedSequence, setSelectedSequence] = useState(null)
  const [preview, setPreview] = useState(null)
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

  // Step 1 → 2: Click a sequence in the picker, fetch the dry-run
  // preview from the API, transition to the preview screen.
  async function loadPreview(sequence) {
    setBusy(true)
    setSelectedSequence(sequence)
    setPreview(null)
    setResult(null)
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: contactIds, source_ref: 'ui', dry_run: true }),
      })
      const json = await res.json()
      if (!json.success) {
        setResult({ error: json.error || 'Preview failed' })
        return
      }
      setPreview(json)
      setStep('preview')
    } catch (e) {
      setResult({ error: e.message || 'Network error' })
    } finally {
      setBusy(false)
    }
  }

  // Step 2 → 3: User confirmed on the preview screen, fire the real
  // enrol call and show the success summary.
  async function confirmEnrol() {
    if (!selectedSequence) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`/api/sequences/${selectedSequence.id}/enrol`, {
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
        sequence: selectedSequence,
      }
      setResult(summary)
      setStep('done')
      onSuccess?.(summary)
    } catch (e) {
      setResult({ error: e.message || 'Network error' })
    } finally {
      setBusy(false)
    }
  }

  function backToPicker() {
    setStep('picking')
    setPreview(null)
    setSelectedSequence(null)
    setResult(null)
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

      {/* Step 3: Success summary after a real enrol. */}
      {step === 'done' && result && !result.error && (
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

      {/* Errors at any step. */}
      {result?.error && (
        <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <div>{result.error}</div>
        </div>
      )}

      {/* Step 2: Preview screen with confirm/back. */}
      {step === 'preview' && preview && (
        <PreviewPanel
          preview={preview}
          sequence={selectedSequence}
          contactCount={contactIds.length}
          maxHCls={maxHCls}
          busy={busy}
          onConfirm={confirmEnrol}
          onBack={backToPicker}
        />
      )}

      {/* Step 1: Sequence list. Shown when not previewing or done. */}
      {step === 'picking' && (
        <>
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
                const isLoadingThis = busy && selectedSequence?.id === s.id
                return (
                  <button
                    key={s.id}
                    onClick={() => loadPreview(s)}
                    disabled={busy}
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
                    {isLoadingThis && (
                      <div className="text-[10px] text-un1t-light mt-1 inline-flex items-center gap-1">
                        <Loader2 size={10} className="animate-spin" /> Building preview…
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const STATUS_PILL = {
  eligible:        'bg-emerald-500/15 text-emerald-700',
  already_active:  'bg-amber-500/15 text-amber-700',
  wrong_location:  'bg-gray-500/15 text-gray-700',
}
const STATUS_LABEL = {
  eligible:        'Eligible',
  already_active:  'Already enrolled',
  wrong_location:  'Wrong location',
}

// Preview screen — what the operator sees between clicking a sequence
// and committing the enrol. Counts up top, sample list below, sticky
// footer with Confirm / Back. Confirm is disabled when nothing would
// actually be enrolled (everyone already enrolled or invalid).
function PreviewPanel({ preview, sequence, contactCount, maxHCls, busy, onConfirm, onBack }) {
  const nothingToDo = preview.would_enrol === 0

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1 mb-3 disabled:opacity-40"
      >
        <ChevronLeft size={11} /> Back to sequences
      </button>

      <div className="text-sm font-medium text-un1t-white mb-1">{sequence.name}</div>
      <p className="text-[11px] text-un1t-light mb-3">
        Preview of what will happen when you enrol {contactCount} contact{contactCount === 1 ? '' : 's'}.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <Stat label="Will enrol" value={preview.would_enrol} tone="emerald" />
        <Stat label="Already in" value={preview.already_active} tone="amber" />
        <Stat label="Wrong loc." value={preview.ignored_invalid} tone="gray" />
      </div>

      {preview.sample && preview.sample.length > 0 && (
        <div className={`mb-3 overflow-y-auto border border-un1t-gray rounded ${maxHCls}`}>
          <div className="text-[10px] uppercase tracking-wider text-un1t-light px-2 py-1.5 bg-un1t-gray/20 sticky top-0">
            Sample ({preview.sample.length} of {preview.total_requested})
          </div>
          <ul className="divide-y divide-un1t-gray/40">
            {preview.sample.map((c) => (
              <li key={c.id} className="px-2 py-1.5 flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="text-un1t-white truncate">{c.name}</div>
                  {c.email && <div className="text-[10px] text-un1t-light truncate">{c.email}</div>}
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_PILL[c.status]}`}>
                  {STATUS_LABEL[c.status] || c.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {nothingToDo && (
        <div className="mb-3 text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded p-2 inline-flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          Nothing to enrol. Every selected contact is either already in this sequence or not at this location.
        </div>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || nothingToDo}
        className="w-full inline-flex items-center justify-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-semibold px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        {busy ? 'Enrolling…' : `Enrol ${preview.would_enrol} contact${preview.would_enrol === 1 ? '' : 's'}`}
      </button>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneCls = tone === 'emerald'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
    : tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700'
      : 'border-un1t-gray bg-un1t-black/40 text-un1t-light'
  return (
    <div className={`border rounded p-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-lg font-semibold leading-tight mt-0.5">{value}</div>
    </div>
  )
}
