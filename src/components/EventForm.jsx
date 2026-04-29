'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Plus, Trash2, GripVertical } from 'lucide-react'

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
          {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Event'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/events')}
          className="text-sm text-un1t-light hover:text-white px-4 py-2.5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
