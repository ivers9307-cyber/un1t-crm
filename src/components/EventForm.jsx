'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Plus, Trash2, Bell, Mail, MessageSquare } from 'lucide-react'

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

  // Reminder config (mig 044). The runner in lib/event-reminders.js
  // picks up every booking ~minutesBefore before its start time and
  // sends one message via the chosen channel. Stored on the
  // event_type itself so each event can have its own reminder
  // policy without authoring a sequence.
  const [reminderEnabled, setReminderEnabled] = useState(!!event?.reminder_enabled)
  const [reminderMinutesBefore, setReminderMinutesBefore] = useState(event?.reminder_minutes_before ?? 1440) // 24h default
  // mig 074: WhatsApp removed as a reminder channel. If a legacy
  // event_type loaded here ever had reminder_channel='whatsapp',
  // fall through to 'email' so the picker doesn't show a phantom
  // selection. The DB CHECK now rejects 'whatsapp' on save.
  const initialChannel = event?.reminder_channel === 'whatsapp' ? 'email' : (event?.reminder_channel || 'email')
  const [reminderChannel, setReminderChannel] = useState(initialChannel)
  const [reminderEmailTemplateId, setReminderEmailTemplateId] = useState(event?.reminder_email_template_id || '')
  const [reminderEmailSubject, setReminderEmailSubject] = useState(event?.reminder_email_subject || '')
  const [reminderSmsBody, setReminderSmsBody] = useState(event?.reminder_sms_body || '')

  // Template list for the email picker. Loaded once when reminders
  // are toggled on (skip the network round-trip when not needed).
  const [emailTemplates, setEmailTemplates] = useState(null)

  useEffect(() => {
    if (!reminderEnabled || !locationId) return
    if (emailTemplates === null) {
      fetch(`/api/templates?location_id=${encodeURIComponent(locationId)}`)
        .then(r => r.json())
        .then(j => setEmailTemplates(j.success ? (j.templates || []) : []))
        .catch(() => setEmailTemplates([]))
    }
  }, [reminderEnabled, locationId, emailTemplates])

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
      // Reminder fields. When disabled we still write the channel /
      // template ids so the operator's last config is preserved if
      // they re-enable later.
      reminder_enabled: reminderEnabled,
      reminder_minutes_before: reminderEnabled ? Number(reminderMinutesBefore) || null : null,
      reminder_channel: reminderEnabled ? reminderChannel : null,
      reminder_email_template_id: reminderEnabled && reminderChannel === 'email' ? (reminderEmailTemplateId || null) : null,
      reminder_email_subject: reminderEnabled && reminderChannel === 'email' ? (reminderEmailSubject || null) : null,
      // mig 074: WhatsApp removed as a reminder channel. We still
      // null this on save so legacy rows that had a template id
      // get cleared out as operators re-save their event types.
      reminder_whatsapp_template_id: null,
      reminder_sms_body: reminderEnabled && reminderChannel === 'sms' ? (reminderSmsBody || null) : null,
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

      {/* Reminder */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider flex items-center gap-2">
            <Bell size={14} /> Reminder
          </h3>
          <label className="text-sm flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reminderEnabled}
              onChange={e => setReminderEnabled(e.target.checked)}
              className="cursor-pointer"
            />
            <span>Enabled</span>
          </label>
        </div>
        <p className="text-xs text-un1t-light">
          Send a one-shot reminder to each booking before it starts. The cron checks every 5 minutes;
          actual send time is within ±1 hour of the configured offset. Reminders are treated as
          <span className="text-un1t-white"> transactional / utility</span> messages —
          marketing opt-outs are ignored, but contacts who've opted out of
          <em> administrative</em> messages won't receive them.
        </p>

        {reminderEnabled && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-1.5">Send this many minutes before</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={reminderMinutesBefore}
                    onChange={e => setReminderMinutesBefore(parseInt(e.target.value) || 0)}
                    className="w-32 bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-xs text-un1t-light">
                    minutes ({Math.round(reminderMinutesBefore / 60 * 10) / 10}h)
                  </span>
                </div>
                <p className="text-[11px] text-un1t-mid mt-1">Common: 1440 = 24h, 120 = 2h, 60 = 1h</p>
              </div>
              <div>
                <label className="block text-sm mb-1.5">Channel</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setReminderChannel('email')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                      reminderChannel === 'email'
                        ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                        : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                    }`}
                  >
                    <Mail size={14} /> Email
                  </button>
                  <button
                    type="button"
                    onClick={() => setReminderChannel('sms')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors ${
                      reminderChannel === 'sms'
                        ? 'bg-un1t-white text-un1t-black border border-un1t-white'
                        : 'border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
                    }`}
                  >
                    <MessageSquare size={14} /> SMS
                  </button>
                </div>
              </div>
            </div>

            {reminderChannel === 'email' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm mb-1.5">Email template</label>
                  <select
                    value={reminderEmailTemplateId}
                    onChange={e => setReminderEmailTemplateId(e.target.value)}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">— Select a template —</option>
                    {(emailTemplates || []).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  {emailTemplates && emailTemplates.length === 0 && (
                    <p className="text-[11px] text-amber-400 mt-1">
                      No email templates yet — create one in Communications → Templates first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Subject (optional override)</label>
                  <input
                    type="text"
                    value={reminderEmailSubject}
                    onChange={e => setReminderEmailSubject(e.target.value)}
                    placeholder="Defaults to the template subject, or 'Reminder: <event name>'"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-un1t-mid mt-1">
                    Available merge tags: {'{{first_name}}'}, {'{{event_name}}'}, {'{{event_time}}'}
                  </p>
                </div>
              </div>
            )}

            {reminderChannel === 'sms' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm">SMS body</label>
                  <span className={`text-[11px] ${reminderSmsBody.length > 160 ? 'text-amber-500' : 'text-un1t-light'}`}>
                    {reminderSmsBody.length} chars
                    {reminderSmsBody.length > 0 && (
                      <> · {reminderSmsBody.length <= 160 ? 1 : Math.ceil(reminderSmsBody.length / 153)} segment{reminderSmsBody.length <= 160 ? '' : 's'}</>
                    )}
                  </span>
                </div>
                <textarea
                  value={reminderSmsBody}
                  onChange={e => setReminderSmsBody(e.target.value)}
                  rows={4}
                  maxLength={1600}
                  placeholder="Hi {{first_name}}, just a reminder for {{event_name}} at {{event_time}}. See you at {{location_name}}."
                  className="w-full bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-y"
                />
                <p className="text-[11px] text-un1t-mid mt-2">
                  Merge tags: <code>{'{{first_name}}'}</code>, <code>{'{{name}}'}</code>,
                  {' '}<code>{'{{event_name}}'}</code>, <code>{'{{event_time}}'}</code>,
                  {' '}<code>{'{{location_name}}'}</code>.
                  Sender ID is set per-location in <span className="text-un1t-light">Settings → Locations → SMS</span>.
                  Single-segment SMS fits 160 chars; longer messages cost more (153 chars per concatenated segment).
                </p>
              </div>
            )}
          </div>
        )}
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
