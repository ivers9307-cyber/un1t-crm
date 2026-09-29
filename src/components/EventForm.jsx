'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Bell, Check, Mail, MessageCircle, UserPlus } from 'lucide-react'

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]

const FIELD_TYPES = [
  { value: 'text', label: 'Text input' },
  { value: 'textarea', label: 'Text area' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio buttons' },
]

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']

const defaultAvailability = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
  sun: null,
}

// EVENTTYPERLS.1 — a refusal from the save route, in words the operator can
// act on. 401/403/404 are the routes' access refusals (canManageEventType);
// a 400 carries validateBody's issues.
function saveError(status, json) {
  if (status === 401) return 'Your session has ended. Sign in again, then save.'
  if (status === 403 || status === 404) {
    return "You can't create or edit booking types at this studio."
  }
  const issue = Array.isArray(json?.issues) ? json.issues[0] : null
  if (issue) return `Could not save: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`
  return json?.error || 'Could not save the booking type. Try again.'
}

export default function EventForm({ event, locationId }) {
  const router = useRouter()
  const isEditing = !!event

  const [name, setName] = useState(event?.name || '')
  const [description, setDescription] = useState(event?.description || '')
  // Stored as raw STRING so the operator can clear the field while
  // they retype. The previous "parseInt(e.target.value) || default"
  // pattern snapped the state back to the default the instant the
  // field went empty (which it must, briefly, between backspace and
  // the first new digit) — React then re-rendered the field with the
  // default, reset the cursor, and ate subsequent keystrokes.
  // Operators reported only being able to use the spinner arrows.
  // We coerce + clamp on submit instead. Initial value coerces to
  // string so React doesn't get a number/string flip-flop.
  const [duration, setDuration] = useState(String(event?.duration_minutes ?? 30))
  const [buffer,   setBuffer]   = useState(String(event?.buffer_minutes ?? 0))
  const [maxDays,  setMaxDays]  = useState(String(event?.max_advance_days ?? 30))
  // Mig 125: how many staff are needed to keep this booking type
  // bookable. Drives the studio overview demand classifier on
  // /schedule. 0 = covered by another role already on shift.
  const [staffRequired, setStaffRequired] = useState(
    event?.staff_required != null ? String(event.staff_required) : '1'
  )
  const [color, setColor] = useState(event?.color || '#3B82F6')
  const [webhookUrl, setWebhookUrl] = useState(event?.webhook_url || '')
  // GLOFOX3.2 (mig 144). When on, public bookings on this event_type
  // push the booking customer to Glofox: search-by-email first
  // (search-and-link if found), otherwise create + attach the per-
  // location trial membership + tag for the welcome sequence.
  // Default off — operator opts in per booking type.
  const [createInGlofox, setCreateInGlofox] = useState(!!event?.create_in_glofox)
  const [availability, setAvailability] = useState(event?.availability || defaultAvailability)
  const [customFields, setCustomFields] = useState(event?.custom_fields || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Set once a create has POSTed: if the reminder sync then fails, a retry
  // PUTs to this row instead of POSTing a second booking type.
  const [createdId, setCreatedId] = useState(null)

  // (mig 081 race-tracking state removed in mig 082 — races are
  // now standalone race_events with their own /races admin UI.)

  // Confirmation config (mig 077 — booking confirmation flow).
  // One-shot message sent at booking creation time. Stored as columns
  // on event_types since confirmations are singular per event_type.
  // Channels: email and/or WhatsApp (EVENTCONFIRM-WA.1, mig 666 — an
  // approved template picked below). SMS was retired with Twilio
  // (TWILIO-RETIRE.1): a legacy 'sms' entry is dropped on load, so it
  // falls away on the next save.
  const [confirmationEnabled, setConfirmationEnabled] = useState(!!event?.confirmation_enabled)
  const [confirmationChannels, setConfirmationChannels] = useState(() => {
    const kept = (Array.isArray(event?.confirmation_channels) ? event.confirmation_channels : [])
      .filter(c => c === 'email' || c === 'whatsapp')
    return kept.length > 0 ? kept : ['email']
  })
  const [confirmationEmailTemplateId, setConfirmationEmailTemplateId] = useState(event?.confirmation_email_template_id || '')
  const [confirmationEmailSubject, setConfirmationEmailSubject] = useState(event?.confirmation_email_subject || '')
  const [confirmationWaTemplateId, setConfirmationWaTemplateId] = useState(event?.confirmation_whatsapp_template_id || '')
  const confirmEmail = confirmationChannels.includes('email')
  const confirmWhatsapp = confirmationChannels.includes('whatsapp')

  function toggleConfirmationChannel(channel) {
    setConfirmationChannels(prev => prev.includes(channel)
      ? prev.filter(c => c !== channel)
      : [...prev, channel])
  }

  // Reminders config (mig 076 — multi-reminder).
  // Each reminder is { _localId|id, hours_before, email_*, active } — email
  // only, same reason as the confirmation above.
  // _localId is a client-only stable key for new rows that
  // haven't been persisted yet. The PUT endpoint mints a real
  // id once the row lands.
  const [reminders, setReminders] = useState([])
  const [remindersLoaded, setRemindersLoaded] = useState(!isEditing)

  // Email template list for the picker(s). One fetch shared
  // across all reminder rows.
  const [emailTemplates, setEmailTemplates] = useState(null)

  // Load existing reminders on edit. New events start empty
  // (operator clicks "Add reminder" to create the first one).
  useEffect(() => {
    if (!isEditing || !event?.id) return
    let cancelled = false
    fetch(`/api/bookings/event-types/${event.id}/reminders`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (j.success && Array.isArray(j.data)) {
          setReminders(j.data.map(r => ({
            id: r.id,
            hours_before: Math.round((r.minutes_before || 0) / 60 * 10) / 10,
            email_template_id: r.email_template_id || '',
            email_subject: r.email_subject || '',
            active: r.active !== false,
          })))
        }
        setRemindersLoaded(true)
      })
      .catch(() => setRemindersLoaded(true))
    return () => { cancelled = true }
  }, [isEditing, event?.id])

  // Email templates loaded lazily — only when there is at least one
  // reminder OR the confirmation sends email.
  const anyEmail = reminders.length > 0 || (confirmationEnabled && confirmEmail)
  useEffect(() => {
    if (!anyEmail || !locationId) return
    if (emailTemplates === null) {
      fetch(`/api/templates?location_id=${encodeURIComponent(locationId)}`)
        .then(r => r.json())
        .then(j => setEmailTemplates(j.success ? (j.templates || []) : []))
        .catch(() => setEmailTemplates([]))
    }
  }, [anyEmail, locationId, emailTemplates])

  // EVENTCONFIRM-WA.1 — approved UTILITY WhatsApp templates at this studio,
  // loaded only once the WhatsApp channel is picked. A booking arrives from a
  // web form (no 24h window), and Meta refuses MARKETING templates on a
  // transactional send, so only UTILITY ones are offered.
  const [waTemplates, setWaTemplates] = useState(null)
  useEffect(() => {
    if (!(confirmationEnabled && confirmWhatsapp) || !locationId || waTemplates !== null) return
    fetch(`/api/whatsapp/templates?location_id=${encodeURIComponent(locationId)}&status=APPROVED`)
      .then(r => r.json())
      .then(j => setWaTemplates(j.success ? (j.templates || []).filter(t => t.category === 'UTILITY') : []))
      .catch(() => setWaTemplates([]))
  }, [confirmationEnabled, confirmWhatsapp, locationId, waTemplates])

  function addReminder() {
    setReminders(prev => [...prev, {
      _localId: typeof crypto !== 'undefined' ? crypto.randomUUID() : `tmp-${Date.now()}-${prev.length}`,
      hours_before: 24,
      email_template_id: '',
      email_subject: '',
      active: true,
    }])
  }

  function updateReminder(idx, patch) {
    setReminders(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }

  function removeReminder(idx) {
    setReminders(prev => prev.filter((_, i) => i !== idx))
  }

  function toggleDay(day) {
    setAvailability(prev => ({
      ...prev,
      [day]: prev[day] ? null : { start: '09:00', end: '18:00' },
    }))
  }

  function updateDayTime(day, field, value) {
    setAvailability(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }))
  }

  function addCustomField() {
    setCustomFields(prev => [...prev, {
      id: crypto.randomUUID(),
      label: '',
      type: 'text',
      options: [],
      required: false,
    }])
  }

  function updateField(index, key, value) {
    setCustomFields(prev => prev.map((f, i) => i === index ? { ...f, [key]: value } : f))
  }

  function removeField(index) {
    setCustomFields(prev => prev.filter((_, i) => i !== index))
  }

  function updateFieldOptions(index, optionsStr) {
    const options = optionsStr.split(',').map(o => o.trim()).filter(Boolean)
    updateField(index, 'options', options)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    // mig 076 — reminder config moved to event_type_reminders.
    // event_types.reminder_* columns were dropped (mig 241).
    //
    // mig 077 — confirmation lives directly on event_types
    // (singular per booking, doesn't need its own table).
    const confirmationActive = confirmationEnabled && confirmationChannels.length > 0
    // Coerce + clamp the string-state numeric fields on submit. The
    // raw strings allow the operator to clear+retype mid-edit; the
    // payload still gets sane numbers within the API/DB ranges.
    const clampInt = (raw, fallback, min, max) => {
      const n = parseInt(raw, 10)
      if (!Number.isFinite(n)) return fallback
      return Math.max(min, Math.min(max, n))
    }
    // No slug: both routes derive it from the name (eventTypeSlug), exactly
    // as this form used to.
    const payload = {
      name,
      description: description || null,
      duration_minutes: clampInt(duration, 30, 1, 1440),
      buffer_minutes:   clampInt(buffer,    0, 0, 1440),
      max_advance_days: clampInt(maxDays,  30, 0, 3650),
      color,
      availability,
      custom_fields: customFields.filter(f => f.label.trim()),
      webhook_url: webhookUrl || null,
      // Mig 125: clamp to 0-50 (matches DB CHECK + API schema). NaN /
      // non-int falls back to the column DEFAULT of 1 so a malformed
      // value doesn't reject the save.
      staff_required: (() => {
        const n = Number(staffRequired)
        if (!Number.isFinite(n) || !Number.isInteger(n)) return 1
        return Math.max(0, Math.min(50, n))
      })(),
      active: true,
      confirmation_enabled: confirmationActive,
      confirmation_channels: confirmationActive ? confirmationChannels : null,
      // Channel-specific fields are nulled when their channel is off, so an
      // old value never leaks through after a toggle.
      confirmation_email_template_id: confirmationActive && confirmEmail ? (confirmationEmailTemplateId || null) : null,
      confirmation_email_subject: confirmationActive && confirmEmail ? (confirmationEmailSubject || null) : null,
      confirmation_whatsapp_template_id: confirmationActive && confirmWhatsapp ? (confirmationWaTemplateId || null) : null,
      // GLOFOX3.2 — explicit boolean so toggling off persists.
      create_in_glofox: createInGlofox === true,
      ...(locationId && !isEditing && !createdId ? { location_id: locationId } : {}),
    }

    // EVENTTYPERLS.1 — save through the guarded routes, never the browser
    // Supabase client (RLS let any member of the studio write event_types
    // that way; mig 650 takes the browser write away). The routes judge
    // canManageEventType's rule: a master, or MANAGER_ROLES at the studio.
    const rowId = event?.id || createdId
    let saved
    try {
      const resp = await fetch(
        rowId ? `/api/bookings/event-types/${rowId}` : '/api/bookings/event-types',
        {
          method: rowId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const json = await resp.json().catch(() => null)
      if (!resp.ok || !json?.success) {
        setError(saveError(resp.status, json))
        setSaving(false)
        return
      }
      saved = json.data
      if (!rowId && saved?.id) setCreatedId(saved.id)
    } catch (err) {
      setError(`Could not save the booking type: ${err.message}`)
      setSaving(false)
      return
    }

    // Sync reminders via PUT /api/bookings/event-types/[id]/reminders. The
    // endpoint takes the full set; server diffs against existing
    // rows. New rows on the form (no id, just _localId) get
    // server-issued ids back.
    const eventId = saved?.id || rowId
    if (eventId) {
      try {
        const reminderPayload = reminders.map(r => ({
          id: r.id,           // omitted for new rows; server treats as insert
          hours_before: Number(r.hours_before) || 0,
          channels: ['email'],
          email_template_id: r.email_template_id || null,
          email_subject: r.email_subject || null,
          active: r.active !== false,
        }))
        const resp = await fetch(`/api/bookings/event-types/${eventId}/reminders`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reminders: reminderPayload }),
        })
        const json = await resp.json()
        if (!json.success) {
          setError(`Saved event but reminder sync failed: ${json.error || 'unknown'}`)
          setSaving(false)
          return
        }
      } catch (e) {
        setError(`Saved event but reminder sync failed: ${e.message}`)
        setSaving(false)
        return
      }
    }

    router.push('/bookings/event-types')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Basic Info</h3>

        <div>
          <label className="block text-sm mb-1.5">Event Name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Free Consultation"
            maxLength={200}
            required
            className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Brief description shown on the booking page"
            maxLength={5000}
            rows={2}
            className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Duration (min)</label>
            <input
              type="number"
              value={duration}
              onChange={e => setDuration(e.target.value)}
              min={5}
              max={480}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Buffer (min)</label>
            <input
              type="number"
              value={buffer}
              onChange={e => setBuffer(e.target.value)}
              min={0}
              max={120}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Max advance (days)</label>
            <input
              type="number"
              value={maxDays}
              onChange={e => setMaxDays(e.target.value)}
              min={1}
              max={365}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            {/* Mig 125: drives the studio overview classifier on /schedule.
                If availability is open today, this many staff must be
                rostered or the day flags amber/red. 0 = no own demand
                (covered by another role already on shift). */}
            <label className="block text-sm mb-1.5" title="Used by the studio overview on /schedule to flag undermanned days">Staff required</label>
            <input
              type="number"
              value={staffRequired}
              onChange={e => setStaffRequired(e.target.value)}
              min={0}
              max={50}
              step={1}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
        <p className="text-[11px] text-un1t-subtle -mt-2">
          <strong>Staff required</strong> drives the demand check on the schedule overview. Default 1 — set 0 if this booking type is covered by another role already on shift (e.g. consultations done by the on-shift PT coach).
        </p>

        <div>
          <label className="block text-sm mb-2">Colour</label>
          <div className="flex gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition-all ${color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-un1t-surface' : 'hover:scale-110'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Availability */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Availability</h3>

        <div className="space-y-2">
          {DAYS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleDay(key)}
                className={`w-20 text-xs py-1.5 rounded text-center transition-colors ${
                  availability[key]
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                    : 'bg-un1t-border/30 text-un1t-subtle border border-un1t-border'
                }`}
              >
                {label.slice(0, 3)}
              </button>
              {availability[key] ? (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={availability[key].start}
                    onChange={e => updateDayTime(key, 'start', e.target.value)}
                    className="bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-un1t-subtle text-sm">to</span>
                  <input
                    type="time"
                    value={availability[key].end}
                    onChange={e => updateDayTime(key, 'end', e.target.value)}
                    className="bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ) : (
                <span className="text-xs text-un1t-subtle">Unavailable</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Custom Form Fields */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Custom Form Fields</h3>
          <button
            type="button"
            onClick={addCustomField}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Plus size={14} />
            Add Field
          </button>
        </div>

        <p className="text-xs text-un1t-subtle">
          Name, email, and phone are always included. Add custom fields for extra information.
        </p>

        {customFields.length === 0 ? (
          <p className="text-xs text-un1t-subtle py-2">No custom fields added yet.</p>
        ) : (
          <div className="space-y-3">
            {customFields.map((field, index) => (
              <div key={field.id} className="bg-un1t-bg border border-un1t-border rounded-lg p-3 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-un1t-subtle mb-1">Label</label>
                        <input
                          type="text"
                          value={field.label}
                          onChange={e => updateField(index, 'label', e.target.value)}
                          placeholder="e.g. Experience level"
                          className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-un1t-subtle mb-1">Type</label>
                        <select
                          value={field.type}
                          onChange={e => updateField(index, 'type', e.target.value)}
                          className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        >
                          {FIELD_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {['dropdown', 'radio'].includes(field.type) && (
                      <div>
                        <label className="block text-xs text-un1t-subtle mb-1">Options (comma-separated)</label>
                        <input
                          type="text"
                          value={(field.options || []).join(', ')}
                          onChange={e => updateFieldOptions(index, e.target.value)}
                          placeholder="e.g. Beginner, Intermediate, Advanced"
                          className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    )}

                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={e => updateField(index, 'required', e.target.checked)}
                        className="rounded border-un1t-border"
                      />
                      <span className="text-un1t-subtle">Required field</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeField(index)}
                    className="text-red-400 hover:text-red-300 p-1 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Booking confirmation (mig 077). One-shot message sent at
          booking creation time. Per-event-type config — singular
          (vs reminders which are multi-row). */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider flex items-center gap-2">
            <Check size={14} /> Booking confirmation
          </h3>
          <label className="text-sm flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmationEnabled}
              onChange={e => setConfirmationEnabled(e.target.checked)}
              className="cursor-pointer"
            />
            <span>Enabled</span>
          </label>
        </div>
        <p className="text-xs text-un1t-subtle">
          Sent immediately when a customer submits a booking, before any reminders fire.
          Treated as a transactional / utility message — administrative opt-out is honoured,
          marketing opt-out isn&apos;t. Send it by email, WhatsApp, or both.
        </p>

        {confirmationEnabled && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm mb-1.5">Channels</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => toggleConfirmationChannel('email')}
                  aria-pressed={confirmationChannels.includes('email')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                    confirmationChannels.includes('email')
                      ? 'bg-un1t-text text-un1t-bg border border-un1t-text'
                      : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted'
                  }`}
                >
                  <Mail size={14} /> Email
                </button>
                <button
                  type="button"
                  onClick={() => toggleConfirmationChannel('whatsapp')}
                  aria-pressed={confirmationChannels.includes('whatsapp')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                    confirmationChannels.includes('whatsapp')
                      ? 'bg-un1t-text text-un1t-bg border border-un1t-text'
                      : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted'
                  }`}
                >
                  <MessageCircle size={14} /> WhatsApp
                </button>
              </div>
              <p className="text-[11px] text-un1t-muted mt-1">
                Pick one or both. Both = a separate email and WhatsApp message go out at booking time.
              </p>
            </div>

            {confirmEmail && (
              <div className="space-y-3 border-t border-un1t-border/50 pt-3">
                <div className="text-[11px] text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                  <Mail size={11} /> Email
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Email template</label>
                  <select
                    value={confirmationEmailTemplateId}
                    onChange={e => setConfirmationEmailTemplateId(e.target.value)}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">— Select a template —</option>
                    {(emailTemplates || []).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  {emailTemplates && emailTemplates.length === 0 && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      No email templates yet — create one in Communications → Templates first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Subject (optional override)</label>
                  <input
                    type="text"
                    value={confirmationEmailSubject}
                    onChange={e => setConfirmationEmailSubject(e.target.value)}
                    maxLength={500}
                    placeholder="Defaults to the template subject, or 'Booking confirmed: <event name>'"
                    className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-un1t-muted mt-1">
                    Merge tags: {'{{first_name}}'}, {'{{event_name}}'}, {'{{event_time}}'}
                  </p>
                </div>
              </div>
            )}

            {confirmWhatsapp && (
              <div className="space-y-2 border-t border-un1t-border/50 pt-3">
                <div className="text-[11px] text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                  <MessageCircle size={11} /> WhatsApp
                </div>
                <label htmlFor="confirmation-wa-template" className="block text-sm">Approved template</label>
                <select
                  id="confirmation-wa-template"
                  value={confirmationWaTemplateId}
                  onChange={e => setConfirmationWaTemplateId(e.target.value)}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">— Select a template —</option>
                  {(waTemplates || []).map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ''}</option>
                  ))}
                </select>
                {waTemplates && waTemplates.length === 0 && (
                  <p className="text-[11px] text-amber-700">
                    No approved Utility templates at this studio yet. Add one under WhatsApp → Templates (category: Utility) and sync.
                  </p>
                )}
                <p className="text-[11px] text-un1t-muted">
                  Fills the template&apos;s variables in order: {'{1}'} first name, {'{2}'} day + time, {'{3}'} event name.
                  Goes to the contact&apos;s WhatsApp number, and is skipped for anyone who has opted out.
                </p>
              </div>
            )}

            {confirmationChannels.length === 0 && (
              <p className="text-[11px] text-amber-700 border-t border-un1t-border/50 pt-3">
                Pick at least one channel — the confirmation won&apos;t be sent without one.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Reminders — multi-reminder (mig 076) */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider flex items-center gap-2">
            <Bell size={14} /> Reminders
          </h3>
          <button
            type="button"
            onClick={addReminder}
            className="text-xs px-2.5 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 flex items-center gap-1"
          >
            <Plus size={12} /> Add reminder
          </button>
        </div>
        <p className="text-xs text-un1t-subtle">
          Set as many email reminders as you want — e.g. 24h before + 2h before.
          Reminders are treated as <span className="text-un1t-text">transactional / utility</span>
          messages — marketing opt-outs are ignored, but contacts who've opted out of
          <em> administrative</em> messages won&apos;t receive them. The cron checks every 5
          minutes; actual send time is within ±1 hour of the configured offset.
        </p>

        {!remindersLoaded && (
          <p className="text-xs text-un1t-muted italic">Loading reminders…</p>
        )}

        {remindersLoaded && reminders.length === 0 && (
          <div className="border border-dashed border-un1t-border rounded-md p-4 text-center text-xs text-un1t-muted">
            No reminders configured. Click <strong>Add reminder</strong> to send one (or many) before each booking.
          </div>
        )}

        {remindersLoaded && reminders.map((r, idx) => {
          return (
            <div
              key={r.id || r._localId || idx}
              className="border border-un1t-border/70 rounded-lg p-4 space-y-3 bg-un1t-bg/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-un1t-subtle text-xs uppercase tracking-wider">Reminder {idx + 1}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeReminder(idx)}
                  className="p-1.5 rounded hover:bg-red-500/20 text-un1t-subtle hover:text-red-700"
                  title="Remove this reminder"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">Send this many hours before</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={r.hours_before ?? 24}
                      onChange={e => updateReminder(idx, { hours_before: parseFloat(e.target.value) || 0 })}
                      className="w-28 bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <span className="text-xs text-un1t-subtle">hours</span>
                  </div>
                  <p className="text-[11px] text-un1t-muted mt-1">Common: 24 = day before · 2 = couple of hours before · 0.5 = 30 min before</p>
                </div>
              </div>

              <div className="space-y-3 border-t border-un1t-border/50 pt-3">
                <div className="text-[11px] text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                  <Mail size={11} /> Email
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Email template</label>
                  <select
                    value={r.email_template_id || ''}
                    onChange={e => updateReminder(idx, { email_template_id: e.target.value })}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">— Select a template —</option>
                    {(emailTemplates || []).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  {emailTemplates && emailTemplates.length === 0 && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      No email templates yet — create one in Communications → Templates first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Subject (optional override)</label>
                  <input
                    type="text"
                    value={r.email_subject || ''}
                    onChange={e => updateReminder(idx, { email_subject: e.target.value })}
                    placeholder="Defaults to the template subject, or 'Reminder: <event name>'"
                    className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-un1t-muted mt-1">
                    Merge tags: {'{{first_name}}'}, {'{{event_name}}'}, {'{{event_time}}'}
                  </p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Glofox sync (GLOFOX3.2 / mig 144). Operator opts each
          booking type in. When on, every public booking against
          this event type fires findOrCreateGlofoxMember in
          create-and-trial mode after the booking lands. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider flex items-center gap-2">
            <UserPlus size={14} /> Glofox sync
          </h3>
          <label className="text-sm flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={createInGlofox}
              onChange={e => setCreateInGlofox(e.target.checked)}
              className="cursor-pointer"
            />
            <span>Create in Glofox</span>
          </label>
        </div>
        <p className="text-xs text-un1t-subtle">
          When on, every booking on this event type pushes the customer to Glofox:
          first we search by email and link if a Glofox account already exists; if
          not, we create a fresh Glofox account, attach this location&apos;s trial
          membership, and tag the contact for the welcome sequence. The member sets
          their own password with Forgot password? in the Glofox app: no password is
          saved or emailed.
        </p>
        {createInGlofox && (
          <p className="text-[11px] text-amber-700">
            Make sure the trial membership picker is set on
            <span className="text-un1t-text"> Settings → Locations → Glofox Integration</span>
            {' '}for this location, otherwise the push will land in the Review tab as
            <em> needs_review</em>.
          </p>
        )}
      </div>

      {/* Webhook (n8n) */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Webhook (n8n)</h3>
        <p className="text-xs text-un1t-subtle">
          When a booking is made, the CRM will POST the booking details to this URL. Use your n8n webhook URL to trigger automations.
        </p>
        <input
          type="url"
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.target.value)}
          placeholder="https://your-n8n.com/webhook/xxxxx"
          className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Submit */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-6 py-2.5 rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create event type'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/bookings/event-types')}
          className="text-sm text-un1t-subtle hover:text-un1t-text px-4 py-2.5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
