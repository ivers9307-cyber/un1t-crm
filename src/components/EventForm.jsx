'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Plus, Trash2, Bell, Check, Mail, MessageSquare } from 'lucide-react'

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

export default function EventForm({ event, locationId }) {
  const router = useRouter()
  const isEditing = !!event

  const [name, setName] = useState(event?.name || '')
  const [description, setDescription] = useState(event?.description || '')
  const [duration, setDuration] = useState(event?.duration_minutes || 30)
  const [buffer, setBuffer] = useState(event?.buffer_minutes || 0)
  const [maxDays, setMaxDays] = useState(event?.max_advance_days || 30)
  const [color, setColor] = useState(event?.color || '#3B82F6')
  const [webhookUrl, setWebhookUrl] = useState(event?.webhook_url || '')
  const [availability, setAvailability] = useState(event?.availability || defaultAvailability)
  const [customFields, setCustomFields] = useState(event?.custom_fields || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Confirmation config (mig 077 — booking confirmation flow).
  // One-shot message sent at booking creation time. Same channel
  // set as reminders (email + sms). Stored as columns on
  // event_types since confirmations are singular per event_type.
  const [confirmationEnabled, setConfirmationEnabled] = useState(!!event?.confirmation_enabled)
  const [confirmationChannels, setConfirmationChannels] = useState(
    Array.isArray(event?.confirmation_channels) && event.confirmation_channels.length > 0
      ? event.confirmation_channels
      : ['email']
  )
  const [confirmationEmailTemplateId, setConfirmationEmailTemplateId] = useState(event?.confirmation_email_template_id || '')
  const [confirmationEmailSubject, setConfirmationEmailSubject] = useState(event?.confirmation_email_subject || '')
  const [confirmationSmsBody, setConfirmationSmsBody] = useState(event?.confirmation_sms_body || '')

  function toggleConfirmationChannel(channel) {
    setConfirmationChannels(prev => prev.includes(channel)
      ? prev.filter(c => c !== channel)
      : [...prev, channel])
  }

  // Reminders config (mig 076 — multi-reminder).
  // Each reminder is { _localId|id, hours_before, channels[], email_*, sms_body, active }.
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
    fetch(`/api/events/${event.id}/reminders`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (j.success && Array.isArray(j.data)) {
          setReminders(j.data.map(r => ({
            id: r.id,
            hours_before: Math.round((r.minutes_before || 0) / 60 * 10) / 10,
            channels: Array.isArray(r.channels) ? r.channels : [],
            email_template_id: r.email_template_id || '',
            email_subject: r.email_subject || '',
            sms_body: r.sms_body || '',
            active: r.active !== false,
          })))
        }
        setRemindersLoaded(true)
      })
      .catch(() => setRemindersLoaded(true))
    return () => { cancelled = true }
  }, [isEditing, event?.id])

  // Email templates loaded lazily — only when at least one
  // reminder OR the confirmation includes email.
  const anyEmail =
    reminders.some(r => r.channels?.includes('email'))
    || (confirmationEnabled && confirmationChannels.includes('email'))
  useEffect(() => {
    if (!anyEmail || !locationId) return
    if (emailTemplates === null) {
      fetch(`/api/templates?location_id=${encodeURIComponent(locationId)}`)
        .then(r => r.json())
        .then(j => setEmailTemplates(j.success ? (j.templates || []) : []))
        .catch(() => setEmailTemplates([]))
    }
  }, [anyEmail, locationId, emailTemplates])

  function addReminder() {
    setReminders(prev => [...prev, {
      _localId: typeof crypto !== 'undefined' ? crypto.randomUUID() : `tmp-${Date.now()}-${prev.length}`,
      hours_before: 24,
      channels: ['email'],
      email_template_id: '',
      email_subject: '',
      sms_body: '',
      active: true,
    }])
  }

  function updateReminder(idx, patch) {
    setReminders(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }

  function removeReminder(idx) {
    setReminders(prev => prev.filter((_, i) => i !== idx))
  }

  function toggleReminderChannel(idx, channel) {
    setReminders(prev => prev.map((r, i) => {
      if (i !== idx) return r
      const has = r.channels?.includes(channel)
      const next = has
        ? r.channels.filter(c => c !== channel)
        : [...(r.channels || []), channel]
      return { ...r, channels: next }
    }))
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

    const db = createBrowserClient()
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

    // mig 076 — reminder config moved to event_type_reminders.
    // event_types.reminder_* columns are still on disk but
    // deprecated; the runner doesn't read them. We stop
    // populating them here too. (A re-saved row gets its old
    // values blanked via update — fine, since they're stale.)
    //
    // mig 077 — confirmation lives directly on event_types
    // (singular per booking, doesn't need its own table).
    // Channel-specific fields are nulled out when their channel
    // isn't selected so old values don't leak through after a
    // channel toggle.
    const confirmationActive = confirmationEnabled && confirmationChannels.length > 0
    const payload = {
      name,
      slug,
      description: description || null,
      duration_minutes: duration,
      buffer_minutes: buffer,
      max_advance_days: maxDays,
      color,
      availability,
      custom_fields: customFields.filter(f => f.label.trim()),
      webhook_url: webhookUrl || null,
      active: true,
      confirmation_enabled: confirmationActive,
      confirmation_channels: confirmationActive ? confirmationChannels : null,
      confirmation_email_template_id:
        confirmationActive && confirmationChannels.includes('email')
          ? (confirmationEmailTemplateId || null) : null,
      confirmation_email_subject:
        confirmationActive && confirmationChannels.includes('email')
          ? (confirmationEmailSubject || null) : null,
      confirmation_sms_body:
        confirmationActive && confirmationChannels.includes('sms')
          ? (confirmationSmsBody || null) : null,
      ...(locationId && !isEditing ? { location_id: locationId } : {}),
    }

    let result
    if (isEditing) {
      result = await db.from('event_types').update(payload).eq('id', event.id).select().single()
    } else {
      result = await db.from('event_types').insert(payload).select().single()
    }

    if (result.error) {
      setError(result.error.message)
      setSaving(false)
      return
    }

    // Sync reminders via PUT /api/events/[id]/reminders. The
    // endpoint takes the full set; server diffs against existing
    // rows. New rows on the form (no id, just _localId) get
    // server-issued ids back.
    const eventId = result.data?.id || event?.id
    if (eventId) {
      try {
        const reminderPayload = reminders
          .filter(r => Array.isArray(r.channels) && r.channels.length > 0)
          .map(r => ({
            id: r.id,           // omitted for new rows; server treats as insert
            hours_before: Number(r.hours_before) || 0,
            channels: r.channels,
            email_template_id: r.channels.includes('email') ? (r.email_template_id || null) : null,
            email_subject: r.channels.includes('email') ? (r.email_subject || null) : null,
            sms_body: r.channels.includes('sms') ? (r.sms_body || null) : null,
            active: r.active !== false,
          }))
        const resp = await fetch(`/api/events/${eventId}/reminders`, {
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

    router.push('/events')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Basic Info</h3>

        <div>
          <label className="block text-sm mb-1.5">Event Name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Free Consultation"
            required
            className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Brief description shown on the booking page"
            rows={2}
            className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Duration (min)</label>
            <input
              type="number"
              value={duration}
              onChange={e => setDuration(parseInt(e.target.value) || 30)}
              min={5}
              max={480}
              className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Buffer (min)</label>
            <input
              type="number"
              value={buffer}
              onChange={e => setBuffer(parseInt(e.target.value) || 0)}
              min={0}
              max={120}
              className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Max advance (days)</label>
            <input
              type="number"
              value={maxDays}
              onChange={e => setMaxDays(parseInt(e.target.value) || 30)}
              min={1}
              max={365}
              className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm mb-2">Colour</label>
          <div className="flex gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition-all ${color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-un1t-dark' : 'hover:scale-110'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Availability */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Availability</h3>

        <div className="space-y-2">
          {DAYS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleDay(key)}
                className={`w-20 text-xs py-1.5 rounded text-center transition-colors ${
                  availability[key]
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                    : 'bg-un1t-gray/30 text-un1t-light border border-un1t-gray'
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
                    className="bg-un1t-black border border-un1t-gray rounded px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-un1t-light text-sm">to</span>
                  <input
                    type="time"
                    value={availability[key].end}
                    onChange={e => updateDayTime(key, 'end', e.target.value)}
                    className="bg-un1t-black border border-un1t-gray rounded px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ) : (
                <span className="text-xs text-un1t-light">Unavailable</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Custom Form Fields */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Custom Form Fields</h3>
          <button
            type="button"
            onClick={addCustomField}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Plus size={14} />
            Add Field
          </button>
        </div>

        <p className="text-xs text-un1t-light">
          Name, email, and phone are always included. Add custom fields for extra information.
        </p>

        {customFields.length === 0 ? (
          <p className="text-xs text-un1t-light py-2">No custom fields added yet.</p>
        ) : (
          <div className="space-y-3">
            {customFields.map((field, index) => (
              <div key={field.id} className="bg-un1t-black border border-un1t-gray rounded-lg p-3 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-un1t-light mb-1">Label</label>
                        <input
                          type="text"
                          value={field.label}
                          onChange={e => updateField(index, 'label', e.target.value)}
                          placeholder="e.g. Experience level"
                          className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-un1t-light mb-1">Type</label>
                        <select
                          value={field.type}
                          onChange={e => updateField(index, 'type', e.target.value)}
                          className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        >
                          {FIELD_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {['dropdown', 'radio'].includes(field.type) && (
                      <div>
                        <label className="block text-xs text-un1t-light mb-1">Options (comma-separated)</label>
                        <input
                          type="text"
                          value={(field.options || []).join(', ')}
                          onChange={e => updateFieldOptions(index, e.target.value)}
                          placeholder="e.g. Beginner, Intermediate, Advanced"
                          className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    )}

                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={e => updateField(index, 'required', e.target.checked)}
                        className="rounded border-un1t-gray"
                      />
                      <span className="text-un1t-light">Required field</span>
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
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider flex items-center gap-2">
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
        <p className="text-xs text-un1t-light">
          Sent immediately when a customer submits a booking, before any reminders fire.
          Treated as a transactional / utility message — administrative opt-out is honoured,
          marketing opt-out isn&apos;t. Same channel set as reminders (email + SMS).
        </p>

        {confirmationEnabled && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm mb-1.5">Channels</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => toggleConfirmationChannel('email')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                    confirmationChannels.includes('email')
                      ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                      : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                  }`}
                >
                  <Mail size={14} /> Email
                </button>
                <button
                  type="button"
                  onClick={() => toggleConfirmationChannel('sms')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                    confirmationChannels.includes('sms')
                      ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                      : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                  }`}
                >
                  <MessageSquare size={14} /> SMS
                </button>
              </div>
              <p className="text-[11px] text-un1t-mid mt-1">
                Pick one or both. Both = a separate email and SMS go out at booking time.
              </p>
            </div>

            {confirmationChannels.includes('email') && (
              <div className="space-y-3 border-t border-un1t-gray/50 pt-3">
                <div className="text-[11px] text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                  <Mail size={11} /> Email
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Email template</label>
                  <select
                    value={confirmationEmailTemplateId}
                    onChange={e => setConfirmationEmailTemplateId(e.target.value)}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
                    placeholder="Defaults to the template subject, or 'Booking confirmed: <event name>'"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-un1t-mid mt-1">
                    Merge tags: {'{{first_name}}'}, {'{{event_name}}'}, {'{{event_time}}'}
                  </p>
                </div>
              </div>
            )}

            {confirmationChannels.includes('sms') && (
              <div className="space-y-2 border-t border-un1t-gray/50 pt-3">
                <div className="text-[11px] text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                  <MessageSquare size={11} /> SMS
                </div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm">SMS body</label>
                  <span className={`text-[11px] ${confirmationSmsBody.length > 160 ? 'text-amber-700' : 'text-un1t-light'}`}>
                    {confirmationSmsBody.length} chars
                    {confirmationSmsBody.length > 0 && (
                      <> · {confirmationSmsBody.length <= 160 ? 1 : Math.ceil(confirmationSmsBody.length / 153)} segment{confirmationSmsBody.length <= 160 ? '' : 's'}</>
                    )}
                  </span>
                </div>
                <textarea
                  value={confirmationSmsBody}
                  onChange={e => setConfirmationSmsBody(e.target.value)}
                  rows={3}
                  maxLength={1600}
                  placeholder="Hi {{first_name}}, your {{event_name}} on {{event_time}} is confirmed. See you at {{location_name}}."
                  className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-y"
                />
                <p className="text-[11px] text-un1t-mid">
                  Merge tags: <code>{'{{first_name}}'}</code>, <code>{'{{name}}'}</code>,
                  {' '}<code>{'{{event_name}}'}</code>, <code>{'{{event_time}}'}</code>,
                  {' '}<code>{'{{location_name}}'}</code>.
                </p>
              </div>
            )}

            {confirmationChannels.length === 0 && (
              <p className="text-[11px] text-amber-700 border-t border-un1t-gray/50 pt-3">
                Pick at least one channel — confirmation won&apos;t be sent without one.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Reminders — multi-reminder (mig 076) */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider flex items-center gap-2">
            <Bell size={14} /> Reminders
          </h3>
          <button
            type="button"
            onClick={addReminder}
            className="text-xs px-2.5 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 flex items-center gap-1"
          >
            <Plus size={12} /> Add reminder
          </button>
        </div>
        <p className="text-xs text-un1t-light">
          Set as many reminders as you want — e.g. 24h email + 2h SMS + day-of both.
          Each reminder picks its own channels (email, SMS, or both). Reminders are
          treated as <span className="text-un1t-white">transactional / utility</span>
          messages — marketing opt-outs are ignored, but contacts who've opted out of
          <em> administrative</em> messages won&apos;t receive them. The cron checks every 5
          minutes; actual send time is within ±1 hour of the configured offset.
        </p>

        {!remindersLoaded && (
          <p className="text-xs text-un1t-mid italic">Loading reminders…</p>
        )}

        {remindersLoaded && reminders.length === 0 && (
          <div className="border border-dashed border-un1t-gray rounded-md p-4 text-center text-xs text-un1t-mid">
            No reminders configured. Click <strong>Add reminder</strong> to send one (or many) before each booking.
          </div>
        )}

        {remindersLoaded && reminders.map((r, idx) => {
          const hasEmail = r.channels?.includes('email')
          const hasSms = r.channels?.includes('sms')
          const smsLen = (r.sms_body || '').length
          return (
            <div
              key={r.id || r._localId || idx}
              className="border border-un1t-gray/70 rounded-lg p-4 space-y-3 bg-un1t-black/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-un1t-light text-xs uppercase tracking-wider">Reminder {idx + 1}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeReminder(idx)}
                  className="p-1.5 rounded hover:bg-red-500/20 text-un1t-light hover:text-red-700"
                  title="Remove this reminder"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">Send this many hours before</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={r.hours_before ?? 24}
                      onChange={e => updateReminder(idx, { hours_before: parseFloat(e.target.value) || 0 })}
                      className="w-28 bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <span className="text-xs text-un1t-light">hours</span>
                  </div>
                  <p className="text-[11px] text-un1t-mid mt-1">Common: 24 = day before · 2 = couple of hours before · 0.5 = 30 min before</p>
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Channels</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => toggleReminderChannel(idx, 'email')}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                        hasEmail
                          ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                          : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                      }`}
                    >
                      <Mail size={14} /> Email
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleReminderChannel(idx, 'sms')}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                        hasSms
                          ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                          : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                      }`}
                    >
                      <MessageSquare size={14} /> SMS
                    </button>
                  </div>
                  <p className="text-[11px] text-un1t-mid mt-1">Pick one or both. Both = a separate email and SMS go out at the same offset.</p>
                </div>
              </div>

              {hasEmail && (
                <div className="space-y-3 border-t border-un1t-gray/50 pt-3">
                  <div className="text-[11px] text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                    <Mail size={11} /> Email
                  </div>
                  <div>
                    <label className="block text-sm mb-1.5">Email template</label>
                    <select
                      value={r.email_template_id || ''}
                      onChange={e => updateReminder(idx, { email_template_id: e.target.value })}
                      className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
                      className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[11px] text-un1t-mid mt-1">
                      Merge tags: {'{{first_name}}'}, {'{{event_name}}'}, {'{{event_time}}'}
                    </p>
                  </div>
                </div>
              )}

              {hasSms && (
                <div className="space-y-2 border-t border-un1t-gray/50 pt-3">
                  <div className="text-[11px] text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                    <MessageSquare size={11} /> SMS
                  </div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm">SMS body</label>
                    <span className={`text-[11px] ${smsLen > 160 ? 'text-amber-700' : 'text-un1t-light'}`}>
                      {smsLen} chars
                      {smsLen > 0 && (
                        <> · {smsLen <= 160 ? 1 : Math.ceil(smsLen / 153)} segment{smsLen <= 160 ? '' : 's'}</>
                      )}
                    </span>
                  </div>
                  <textarea
                    value={r.sms_body || ''}
                    onChange={e => updateReminder(idx, { sms_body: e.target.value })}
                    rows={3}
                    maxLength={1600}
                    placeholder="Hi {{first_name}}, just a reminder for {{event_name}} at {{event_time}}. See you at {{location_name}}."
                    className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-y"
                  />
                  <p className="text-[11px] text-un1t-mid">
                    Merge tags: <code>{'{{first_name}}'}</code>, <code>{'{{name}}'}</code>,
                    {' '}<code>{'{{event_name}}'}</code>, <code>{'{{event_time}}'}</code>,
                    {' '}<code>{'{{location_name}}'}</code>.
                    Sender ID is set per-location in <span className="text-un1t-light">Settings → Locations → SMS</span>.
                  </p>
                </div>
              )}

              {!hasEmail && !hasSms && (
                <p className="text-[11px] text-amber-700">
                  Pick at least one channel above. A reminder with no channels is ignored on save.
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Webhook (n8n) */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Webhook (n8n)</h3>
        <p className="text-xs text-un1t-light">
          When a booking is made, the CRM will POST the booking details to this URL. Use your n8n webhook URL to trigger automations.
        </p>
        <input
          type="url"
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.target.value)}
          placeholder="https://your-n8n.com/webhook/xxxxx"
          className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
          onClick={() => router.push('/events')}
          className="text-sm text-un1t-light hover:text-un1t-white px-4 py-2.5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
