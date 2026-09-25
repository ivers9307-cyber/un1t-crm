'use client'

// TPLCLONE.1 — copy shift templates INTO the studio on screen from another
// studio of the same organisation.
//
// The preview is a dry run of the same route that copies, so what it calls
// "already here" is the server's rule, not a second copy of it in the browser.
// The copy then sends only the templates still ticked; the answer (created,
// skipped, the shifts it put on the calendar, any warning) goes back to the
// template manager, which owns the notice.
//
// Weekdays are NOT copied unless the manager ticks "Also copy the weekdays":
// copying them fills the next eight weeks at this studio with empty shifts to
// staff and switches its roster alerts on. The preview carries each source
// template's weekdays either way, so ticking the box needs no second request.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from '@/components/ui/Modal'
import { formatTime12h as formatTime } from '@/lib/schedule-overlap'
import { CLONE_SKIP_LABELS } from '@/lib/shift-template-clone'
import ScheduleErrorBanner from './ScheduleErrorBanner'
import { readJson } from './useScheduleData'

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function weekdaysOf(days) {
  return DAY_ORDER.filter((d) => (days || []).includes(d)).map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
}

export default function CopyTemplatesModal({ sources, target, onClose, onDone }) {
  const selectId = useId()
  const weekdaysId = useId()
  const [fromId, setFromId] = useState(sources.length === 1 ? sources[0].id : '')
  const [preview, setPreview] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [copyWeekdays, setCopyWeekdays] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // A slow preview of the studio chosen first must not land over the one chosen after it.
  const requestSeq = useRef(0)
  const fromName = sources.find((s) => s.id === fromId)?.name || 'the other studio'

  const post = useCallback((extra) => readJson('/api/schedule/templates/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_location_id: fromId, to_location_id: target.id, ...extra }),
  }), [fromId, target.id])

  const loadPreview = useCallback(async () => {
    if (!fromId) return
    const mine = ++requestSeq.current
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      const res = await post({ dry_run: true })
      if (mine !== requestSeq.current) return
      const data = res.data || { created: [], skipped: [] }
      setPreview(data)
      setSelected(new Set((data.created || []).map((c) => c.source_id)))
    } catch (e) {
      if (mine === requestSeq.current) setError(e?.message || 'Could not read the templates to copy')
    } finally {
      if (mine === requestSeq.current) setLoading(false)
    }
  }, [fromId, post])

  useEffect(() => { loadPreview() }, [loadPreview])

  const created = preview?.created || []
  const skipped = preview?.skipped || []
  const chosen = created.filter((c) => selected.has(c.source_id))
  const hasWeekdays = (c) => (c.source_days_of_week || []).length > 0
  const anyWeekdays = created.some(hasWeekdays)
  const withDays = copyWeekdays ? chosen.filter(hasWeekdays).length : 0

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function daysLabel(c) {
    const source = weekdaysOf(c.source_days_of_week)
    if (!source) return 'One-off'
    return copyWeekdays ? source : `One-off (${source} at ${fromName})`
  }

  async function confirmCopy() {
    if (saving || chosen.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const res = await post({ template_ids: chosen.map((c) => c.source_id), copy_weekdays: copyWeekdays })
      onDone({ ...(res.data || {}), warning: res.warning || null, fromName })
    } catch (e) {
      setError(e?.message || 'Could not copy the templates')
    } finally {
      setSaving(false)
    }
  }

  const copyLabel = saving
    ? 'Copying…'
    : chosen.length > 0
      ? `Copy ${chosen.length} template${chosen.length === 1 ? '' : 's'}`
      : 'Copy templates'

  return (
    <Modal
      open
      onClose={onClose}
      title={`Copy templates to ${target.name}`}
      dismissOnBackdrop={false}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-border/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmCopy}
            disabled={saving || loading || chosen.length === 0}
            className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {copyLabel}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        {sources.length > 1 ? (
          <div>
            <label htmlFor={selectId} className="block text-xs text-un1t-subtle mb-1">Copy from</label>
            <select
              id={selectId}
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">Choose a studio</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ) : (
          <p className="text-sm text-un1t-subtle">From {fromName}.</p>
        )}
        <p className="text-xs text-un1t-subtle">
          Only active templates are copied. A template whose name is already used here is left alone.
        </p>

        {error && (
          <ScheduleErrorBanner
            title="Could not copy templates"
            message={error}
            onRetry={preview ? undefined : loadPreview}
            busy={loading}
            onDismiss={() => setError(null)}
          />
        )}

        {loading && <p className="text-sm text-un1t-subtle">Reading templates at {fromName}…</p>}

        {preview && created.length === 0 && (
          <p className="text-sm text-un1t-subtle">
            Nothing to copy: every active template at {fromName} already has a template of the same name here.
          </p>
        )}

        {created.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-muted mb-2">
              Will be created ({chosen.length} of {created.length})
            </h3>
            <ul className="space-y-1 max-h-64 overflow-y-auto">
              {created.map((c) => (
                <li key={c.source_id}>
                  <label className="flex items-center gap-2 text-sm text-un1t-text">
                    <input
                      type="checkbox"
                      checked={selected.has(c.source_id)}
                      onChange={() => toggle(c.source_id)}
                    />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-un1t-subtle">
                      {formatTime(c.start_time)} – {formatTime(c.end_time)} · {daysLabel(c)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Off by default (owner's call): copied templates land as one-offs,
            so the calendar and the roster alerts here are left alone. */}
        {anyWeekdays && (
          <div>
            <label className="flex items-center gap-2 text-sm text-un1t-text">
              <input
                type="checkbox"
                checked={copyWeekdays}
                onChange={(e) => setCopyWeekdays(e.target.checked)}
                aria-describedby={weekdaysId}
              />
              Also copy the weekdays these shifts repeat on
            </label>
            <p id={weekdaysId} className="text-xs text-un1t-subtle mt-1 ml-6">
              Checking this fills the next eight weeks at {target.name} with shifts to staff.
            </p>
          </div>
        )}

        {skipped.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-muted mb-2">
              Skipped ({skipped.length})
            </h3>
            <ul className="space-y-1 max-h-40 overflow-y-auto text-sm text-un1t-subtle">
              {skipped.map((s) => (
                <li key={`${s.source_id}|${s.reason}`}>
                  <span className="font-medium text-un1t-text">{s.name || 'A template'}</span> — {CLONE_SKIP_LABELS[s.reason] || s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {withDays > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm text-amber-700">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div>
              {withDays} of these {withDays === 1 ? 'runs' : 'run'} on set weekdays, so {target.name} gets empty shifts for {withDays === 1 ? 'it' : 'them'} over the next 8 weeks, and {withDays === 1 ? 'it counts' : 'they count'} toward its roster alerts.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
