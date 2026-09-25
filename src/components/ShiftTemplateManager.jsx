'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Clock, Pencil, Trash2, Users, Ban, ChevronUp, ChevronDown, Check } from 'lucide-react'
import Modal from '@/components/ui/Modal'
// ROSTER-FIX.6a — one failure shape and one banner across the schedule
// screens, so no call site can quietly forget to check the response.
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'
// ROSTER-FIX.6c — the 12-hour shift label was a byte-identical local copy in
// three schedule screens. One definition now, in the lib that already owns
// schedule time formatting.
import { formatTime12h as formatTime } from '@/lib/schedule-overlap'

const PRESET_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
// ROSTER-FIX.6b — the swatches are eight empty buttons whose only content is
// a background colour, so a screen reader read eight identical "button"s and
// the picker was unusable without sight. A hex code is not a name either.
const COLOR_NAMES = {
  '#3B82F6': 'Blue', '#10B981': 'Green', '#F59E0B': 'Amber', '#EF4444': 'Red',
  '#8B5CF6': 'Violet', '#EC4899': 'Pink', '#06B6D4': 'Cyan', '#F97316': 'Orange',
}
const DAY_OPTIONS = [
  { code: 'mon', label: 'Mon' },
  { code: 'tue', label: 'Tue' },
  { code: 'wed', label: 'Wed' },
  { code: 'thu', label: 'Thu' },
  { code: 'fri', label: 'Fri' },
  { code: 'sat', label: 'Sat' },
  { code: 'sun', label: 'Sun' },
]

// SHIFTTYPE.1 (mig 628) — what kind of shift a template makes. The hint is
// the rule in the operator's words, so the choice explains itself.
const KIND_OPTIONS = [
  { value: 'class', label: 'Class', hint: 'Needs coaches. Flagged when below its minimum.' },
  { value: 'admin', label: 'Admin', hint: 'No minimum. Never flagged as a gap, outside the contractor budget; hours still count.' },
]

function formatDays(days) {
  if (!days || days.length === 0) return null
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  return order
    .filter(d => days.includes(d))
    .map(d => d.charAt(0).toUpperCase() + d.slice(1))
    .join(', ')
}

// SHIFTTPL.1 — "min 2, up to 10". The minimum was editable on the form and
// then invisible on the list, so the number that decides whether a shift
// flags understaffed could only be read by opening the editor.
function coachRangeLabel(t) {
  const max = t.max_coaches || 15
  const min = t.min_coaches == null ? 1 : t.min_coaches
  const maxPart = `up to ${max} ${max === 1 ? 'coach' : 'coaches'}`
  return min === 0 ? `no minimum, ${maxPart}` : `min ${min}, ${maxPart}`
}

// What the deactivate actually did to the calendar. `publishedEmptiesKept`
// is the count deliberately left alone: those slots are on a week staff have
// already been shown, and nothing here would record their disappearance.
function deactivateNotice(propagation) {
  const deleted = propagation?.deactivatedBlocksDeleted || 0
  const kept = propagation?.publishedEmptiesKept || 0
  const parts = [deleted === 0
    ? 'Deactivated. No empty future slots to clear.'
    : `Deactivated and cleared ${deleted} empty future slot${deleted === 1 ? '' : 's'}.`]
  if (kept > 0) {
    parts.push(`${kept} empty slot${kept === 1 ? '' : 's'} on an already-published week ${kept === 1 ? 'was' : 'were'} kept.`)
  }
  return parts.join(' ')
}

export default function ShiftTemplateManager({ user }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false) // false, 'new', or template object for editing
  // ROSTER-FIX.6a — the load cleared `loading` on the happy path only, so a
  // refused or dropped request left this screen on "Loading templates..."
  // forever. `busyId` is the single-flight guard for deactivate/reactivate.
  // SHIFTTPL.1 — `error` is no longer only a failed LOAD: a refused hard
  // delete lands here too, and rendering "Could not load shift templates" over
  // "this template has shifts on the calendar" with a Retry button would be
  // three kinds of wrong. The title travels with the message, and Retry is
  // offered only where retrying is the answer.
  const [error, setError] = useState(null)
  const [errorTitle, setErrorTitle] = useState('Could not load shift templates')
  // SHIFTTPL.1 — the destructive actions now report what they DID (slots
  // cleared, row deleted). There was no success channel on this screen at
  // all, so a deactivate that also removed twelve empty future slots looked
  // identical to one that removed none.
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const locationId = user.activeLocation?.id

  // One place that sets both, so a new call site cannot forget the title.
  const failWith = useCallback((title, message) => {
    setErrorTitle(title)
    setError(message)
  }, [])

  const fetchTemplates = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await readJson(`/api/schedule/templates?location_id=${locationId}`)
      setTemplates(data.data || [])
    } catch (e) {
      setErrorTitle('Could not load shift templates')
      setError(e?.message || 'Could not load shift templates')
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  async function handleSave(formData) {
    const isEdit = typeof showForm === 'object'
    const url = isEdit ? `/api/schedule/templates/${showForm.id}` : '/api/schedule/templates'
    const method = isEdit ? 'PUT' : 'POST'

    const payload = {
      ...formData,
      location_id: locationId,
    }

    setError(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        failWith('Could not save this template', data.error || 'Failed to save')
        return
      }
      setShowForm(false)
      fetchTemplates()
      // If the API generated blocks, surface the count so the
      // operator knows their schedule is ready to staff.
      if (data.generated?.inserted > 0) {
        // Use a non-blocking inline pattern via the template list
        // (rebuilt on next render). The transient toast pattern
        // isn't wired across the codebase yet — keeping this simple.
        console.info(`Generated ${data.generated.inserted} blocks for the next 8 weeks.`)
      }
    } catch {
      failWith('Could not save this template', 'Network error, please try again')
    }
  }

  // ROSTER-FIX.6a — both of these DISCARDED the response entirely: they
  // awaited the fetch and refetched regardless, so a refused deactivate or
  // reactivate looked exactly like a successful one and the row simply
  // reappeared where it was.
  async function setTemplateActive(id, active) {
    if (busyId) return
    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/schedule/templates/${id}`, active
        ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) }
        : { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        failWith(active ? 'Could not reactivate this template' : 'Could not deactivate this template',
          data.error || (active ? 'Failed to reactivate' : 'Failed to deactivate'))
        return
      }
      // SHIFTTPL.1 — the DELETE route clears the empty future slots now (the
      // PUT path always did), so say what went and what was deliberately kept.
      if (!active) setNotice(deactivateNotice(data.propagation))
      if (data.warning) failWith('The template changed, but the calendar did not fully follow', data.warning)
      await fetchTemplates()
    } catch {
      failWith(active ? 'Could not reactivate this template' : 'Could not deactivate this template', 'Network error, please try again')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeactivate(id) {
    if (!confirm('Deactivate this shift template? Shifts already on the calendar with a coach on them stay; empty future slots are cleared.')) return
    await setTemplateActive(id, false)
  }

  // SHIFTTPL.1 — a template created by mistake could only ever be
  // deactivated, so it sat in the Inactive list forever. The server decides:
  // it deletes only a template with no shifts and no assignments EVER, and
  // otherwise answers 409 with a sentence naming what is in the way.
  async function handleDelete(t) {
    if (busyId) return
    if (!confirm(`Permanently delete "${t.name}"? This only works if it has never had a shift on the calendar. Otherwise deactivate it instead.`)) return
    setBusyId(t.id)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/schedule/templates/${t.id}?hard=true`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (data.error === 'template_in_use') {
        failWith('This template was kept', data.message || 'This template has shifts on the calendar, so it cannot be deleted. Deactivate it instead.')
        return
      }
      if (!res.ok || data.success === false) {
        failWith('Could not delete this template', data.error || 'Failed to delete')
        return
      }
      setNotice(`"${t.name}" was deleted.`)
      await fetchTemplates()
    } catch {
      failWith('Could not delete this template', 'Network error, please try again')
    } finally {
      setBusyId(null)
    }
  }

  // SHIFTTPL.1 — `display_order` has existed since the table did and nothing
  // ever wrote it, so every template sat at 0 and the list fell back to
  // start_time. Moving a row writes a dense 0..n-1 order for the ACTIVE list
  // and PUTs only the rows whose number actually changed (a display_order-only
  // PUT is the one edit the route does not regenerate blocks for).
  async function moveTemplate(id, delta) {
    if (busyId) return
    const ordered = activeTemplates.slice()
    const from = ordered.findIndex((t) => t.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ordered.length) return
    const [moved] = ordered.splice(from, 1)
    ordered.splice(to, 0, moved)

    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      for (const [index, t] of ordered.entries()) {
        if (t.display_order === index) continue
        const res = await fetch(`/api/schedule/templates/${t.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_order: index }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.success === false) {
          // Stop at the first refusal and re-read: a half-applied order is
          // still a valid order, and guessing at the rest would hide it.
          failWith('Could not save the new order', data.error || 'The order was only partly saved')
          break
        }
      }
      await fetchTemplates()
    } catch {
      failWith('Could not save the new order', 'Network error, please try again')
    } finally {
      setBusyId(null)
    }
  }

  const activeTemplates = templates.filter(t => t.active)
  const inactiveTemplates = templates.filter(t => !t.active)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Shift Templates</h2>
          <p className="text-sm text-un1t-subtle mt-1">{user.activeLocation?.name} — Define your demand windows (when the studio needs coaches)</p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm('new')}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={16} /> New Shift
        </button>
      </div>

      {/* SHIFTTPL.1 — the "N templates without applicable days" warning is
          gone. A template with no weekdays is the ONLY way to express a
          one-off shift you place by hand, and operators keep them on purpose,
          so the banner nagged forever about a deliberate choice and nothing
          could ever clear it. The state is still visible, as a label on the
          row that says what it IS rather than what is wrong with it. */}
      {notice && (
        <div
          className="mb-4 flex items-start gap-2 p-3 rounded-lg border border-green-500/40 bg-green-500/10 text-sm text-green-700"
          role="status"
          data-testid="template-notice"
        >
          <Check size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div>{notice}</div>
        </div>
      )}

      {error && (
        <ScheduleErrorBanner
          title={errorTitle}
          message={error}
          // Retry re-reads the list, which only answers a failed LOAD. A
          // refused delete is not retryable, and offering it would read as
          // "try again and it might work".
          onRetry={errorTitle === 'Could not load shift templates' ? fetchTemplates : undefined}
          busy={loading}
          onDismiss={() => setError(null)}
        />
      )}

      {loading ? (
        <div className="text-center py-12 text-un1t-subtle">Loading templates...</div>
      ) : activeTemplates.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center">
          <Clock size={40} className="mx-auto mb-4 text-un1t-subtle" />
          <h3 className="text-lg font-semibold mb-2">No shift templates yet</h3>
          <p className="text-sm text-un1t-subtle mb-4">Create your first shift to start building rosters</p>
          <button
            type="button"
            onClick={() => setShowForm('new')}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} /> Create Shift
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {activeTemplates.map((t, index) => {
            const daysLabel = formatDays(t.days_of_week)
            const oneOff = !daysLabel
            return (
              <div key={t.id} className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-3 h-10 rounded-full" style={{ backgroundColor: t.color }} />
                  <div>
                    <div className="font-semibold">{t.name}</div>
                    <div className="text-sm text-un1t-subtle flex items-center gap-3 mt-0.5 flex-wrap">
                      <span className="flex items-center gap-1"><Clock size={12} /> {formatTime(t.start_time)} – {formatTime(t.end_time)}</span>
                      {/* SHIFTTPL.1 — the minimum was set on the form and then
                          never shown again, so the number driving every
                          understaffed flag in the estate was invisible here. */}
                      <span className="flex items-center gap-1"><Users size={12} /> {coachRangeLabel(t)}</span>
                      {t.kind === 'admin' && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium bg-slate-500/10 text-slate-700"
                          title="Admin shift: no minimum, never flagged as a gap, outside the contractor budget. Hours still count."
                        >
                          Admin
                        </span>
                      )}
                      {oneOff ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium bg-slate-500/10 text-slate-700"
                          title="No weekdays set, so no shifts are generated. Add them by hand on the calendar."
                        >
                          One-off
                        </span>
                      ) : (
                        <span>{daysLabel}</span>
                      )}
                      {t.role_label && <span>Default: {t.role_label}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveTemplate(t.id, -1)}
                    disabled={busyId != null || index === 0}
                    className="p-2 rounded hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors disabled:opacity-30"
                    aria-label={`Move the ${t.name} template up`}
                    title="Move up"
                  >
                    <ChevronUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveTemplate(t.id, 1)}
                    disabled={busyId != null || index === activeTemplates.length - 1}
                    className="p-2 rounded hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors disabled:opacity-30"
                    aria-label={`Move the ${t.name} template down`}
                    title="Move down"
                  >
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowForm(t)}
                    className="p-2 rounded hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
                    aria-label={`Edit the ${t.name} template`}
                    title="Edit"
                  >
                    <Pencil size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeactivate(t.id)}
                    className="p-2 rounded hover:bg-amber-500/20 text-un1t-subtle hover:text-amber-700 transition-colors disabled:opacity-50"
                    disabled={busyId === t.id}
                    aria-label={`Deactivate the ${t.name} template`}
                    title="Deactivate"
                  >
                    <Ban size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(t)}
                    className="p-2 rounded hover:bg-red-500/20 text-un1t-subtle hover:text-red-700 transition-colors disabled:opacity-50"
                    disabled={busyId === t.id}
                    aria-label={`Delete the ${t.name} template permanently`}
                    title="Delete permanently"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}

          {inactiveTemplates.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-muted mb-2">Inactive</h4>
              {inactiveTemplates.map(t => (
                <div key={t.id} className="bg-un1t-surface/50 border border-un1t-border/50 rounded-lg p-3 flex items-center justify-between opacity-60 mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="text-sm">{t.name} ({formatTime(t.start_time)}–{formatTime(t.end_time)})</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label={`Reactivate the ${t.name} template`}
                      onClick={() => setTemplateActive(t.id, true)}
                      disabled={busyId === t.id}
                      className="text-xs text-blue-700 hover:text-blue-800 disabled:opacity-50"
                    >
                      Reactivate
                    </button>
                    {/* SHIFTTPL.1 — the deactivated list is where a template
                        created by mistake ends up, so this is where deleting
                        it for good has to be reachable. */}
                    <button
                      type="button"
                      aria-label={`Delete the ${t.name} template permanently`}
                      onClick={() => handleDelete(t)}
                      disabled={busyId === t.id}
                      className="text-xs text-red-700 hover:text-red-800 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <TemplateFormModal
          template={typeof showForm === 'object' ? showForm : null}
          onSave={handleSave}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  )
}

function TemplateFormModal({ template, onSave, onClose }) {
  const [name, setName] = useState(template?.name || '')
  const [startTime, setStartTime] = useState(template?.start_time?.slice(0, 5) || '06:00')
  const [endTime, setEndTime] = useState(template?.end_time?.slice(0, 5) || '14:00')
  const [color, setColor] = useState(template?.color || '#3B82F6')
  const [roleLabel, setRoleLabel] = useState(template?.role_label || '')
  const [days, setDays] = useState(template?.days_of_week || [])
  const [maxCoaches, setMaxCoaches] = useState(template?.max_coaches || 15)
  // SHIFTMIN.1 — minimum coaches required. Default 1 on new templates;
  // existing templates default to 1 via the migration so the feature
  // delivers value on day 1 (any 0-assignment block flips amber).
  const [minCoaches, setMinCoaches] = useState(
    template?.min_coaches === 0 ? 0 : (template?.min_coaches || 1)
  )
  // SHIFTTYPE.1 — an admin template has no minimum; the API refuses one
  // (admin_has_no_minimum), so the field is locked at 0 while Admin is chosen.
  const [kind, setKind] = useState(template?.kind === 'admin' ? 'admin' : 'class')

  function chooseKind(next) {
    if (next === kind) return
    setKind(next)
    if (next === 'admin') setMinCoaches(0)
    // Leaving admin: the same default a new class template gets (SHIFTMIN.1).
    else if (minCoaches === 0) setMinCoaches(1)
  }

  function toggleDay(code) {
    setDays(prev => prev.includes(code) ? prev.filter(d => d !== code) : [...prev, code])
  }

  function selectAllWeek() {
    setDays(['mon', 'tue', 'wed', 'thu', 'fri'])
  }

  function selectAll() {
    setDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  }

  function clearAll() {
    setDays([])
  }

  return (
    // ROSTER-FIX.6b — a template form always holds a name, times and days,
    // so the backdrop never dismisses it. Escape and Close still do.
    <Modal
      open
      onClose={onClose}
      title={template ? 'Edit Shift Template' : 'New Shift Template'}
      dismissOnBackdrop={false}
    >
      <div>
        <div className="space-y-4 pr-1">
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Morning, Afternoon, Evening"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>

          <fieldset>
            <legend className="block text-xs text-un1t-subtle mb-1">Kind *</legend>
            <div className="grid grid-cols-2 gap-2">
              {KIND_OPTIONS.map((k) => (
                <label
                  key={k.value}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer bg-un1t-bg ${
                    kind === k.value ? 'border-un1t-text' : 'border-un1t-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="template-kind"
                    value={k.value}
                    checked={kind === k.value}
                    onChange={() => chooseKind(k.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-un1t-text">{k.label}</span>
                    <span className="block text-[11px] text-un1t-subtle">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">Start Time *</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">End Time *</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-un1t-subtle">Days this shift applies to *</label>
              <div className="flex items-center gap-2 text-[11px]">
                <button type="button" onClick={selectAllWeek} className="text-blue-700 hover:text-blue-800">Mon–Fri</button>
                <span className="text-un1t-muted">·</span>
                <button type="button" onClick={selectAll} className="text-blue-700 hover:text-blue-800">All</button>
                <span className="text-un1t-muted">·</span>
                <button type="button" onClick={clearAll} className="text-un1t-subtle hover:text-un1t-text">Clear</button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {DAY_OPTIONS.map(d => {
                const selected = days.includes(d.code)
                return (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => toggleDay(d.code)}
                    className={`py-2 rounded text-xs font-medium border transition-colors ${
                      selected
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-un1t-bg border-un1t-border text-un1t-subtle hover:border-un1t-muted'
                    }`}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-un1t-subtle mt-1.5">
              When you save, blocks for the next 8 weeks are generated for these days. Existing blocks aren&apos;t touched.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="template-min-coaches" className="block text-xs text-un1t-subtle mb-1">Minimum coaches *</label>
              <input
                id="template-min-coaches"
                type="number"
                min={0}
                max={maxCoaches}
                value={minCoaches}
                disabled={kind === 'admin'}
                onChange={e => {
                  const v = Math.max(0, Math.min(maxCoaches, parseInt(e.target.value || '0', 10)))
                  setMinCoaches(v)
                }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
              />
              <p className="text-[11px] text-un1t-subtle mt-1.5">
                {kind === 'admin'
                  ? 'Admin shifts have no minimum.'
                  : 'Blocks with fewer assigned flip the Studio Overview to amber. 0 = no floor.'}
              </p>
            </div>
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">Maximum coaches *</label>
              <input
                type="number"
                min={Math.max(1, minCoaches)}
                max={50}
                value={maxCoaches}
                onChange={e => {
                  const v = Math.max(1, Math.min(50, parseInt(e.target.value || '1', 10)))
                  setMaxCoaches(v)
                  // Keep min ≤ max — if the operator lowered max below
                  // the current min, snap min down too.
                  if (minCoaches > v) setMinCoaches(v)
                }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
              <p className="text-[11px] text-un1t-subtle mt-1.5">
                Set high enough to cover an &ldquo;all-hands&rdquo; day.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Default Role / Position</label>
            <input
              type="text"
              value={roleLabel}
              onChange={e => setRoleLabel(e.target.value)}
              placeholder="e.g. Floor Coach, Front Desk (optional)"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>

          <div>
            <label className="block text-xs text-un1t-subtle mb-2">Colour</label>
            <div className="flex gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={COLOR_NAMES[c] || c}
                  aria-pressed={color === c}
                  title={COLOR_NAMES[c] || c}
                  className={`w-8 h-8 rounded-full transition-transform ${color === c ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-un1t-surface' : 'hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() =>
            name &&
            startTime &&
            endTime &&
            onSave({
              name,
              start_time: startTime,
              end_time: endTime,
              color,
              role_label: roleLabel || null,
              days_of_week: days,
              max_coaches: maxCoaches,
              min_coaches: minCoaches,
              kind,
            })
          }
          disabled={!name || !startTime || !endTime}
          className="w-full mt-5 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {template ? 'Save Changes' : 'Create Shift Template'}
        </button>
      </div>
    </Modal>
  )
}
