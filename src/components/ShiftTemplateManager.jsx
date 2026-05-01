'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Clock, Pencil, Trash2, X } from 'lucide-react'

const PRESET_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

export default function ShiftTemplateManager({ user }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false) // false, 'new', or template object for editing
  const locationId = user.activeLocation?.id

  const fetchTemplates = useCallback(async () => {
    if (!locationId) return
    setLoading(true)
    const res = await fetch(`/api/schedule/templates?location_id=${locationId}`)
    const data = await res.json()
    setTemplates(data.data || [])
    setLoading(false)
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

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    if (data.success) {
      setShowForm(false)
      fetchTemplates()
    } else {
      alert(data.error || 'Failed to save')
    }
  }

  async function handleDeactivate(id) {
    if (!confirm('Deactivate this shift template? Existing shifts using it will remain.')) return
    await fetch(`/api/schedule/templates/${id}`, { method: 'DELETE' })
    fetchTemplates()
  }

  const activeTemplates = templates.filter(t => t.active)
  const inactiveTemplates = templates.filter(t => !t.active)

  return (
    <div>
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-6">
        <ArrowLeft size={16} /> Back to Settings
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Shift Templates</h2>
          <p className="text-sm text-un1t-light mt-1">{user.activeLocation?.name} — Define your named shifts</p>
        </div>
        <button
          onClick={() => setShowForm('new')}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={16} /> New Shift
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-un1t-light">Loading templates...</div>
      ) : activeTemplates.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <Clock size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No shift templates yet</h3>
          <p className="text-sm text-un1t-light mb-4">Create your first shift to start building rosters</p>
          <button
            onClick={() => setShowForm('new')}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={16} /> Create Shift
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {activeTemplates.map(t => (
            <div key={t.id} className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-3 h-10 rounded-full" style={{ backgroundColor: t.color }} />
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-sm text-un1t-light flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1"><Clock size={12} /> {formatTime(t.start_time)} – {formatTime(t.end_time)}</span>
                    {t.role_label && <span>Default role: {t.role_label}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowForm(t)}
                  className="p-2 rounded hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
                  title="Edit"
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => handleDeactivate(t.id)}
                  className="p-2 rounded hover:bg-red-500/20 text-un1t-light hover:text-red-400 transition-colors"
                  title="Deactivate"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}

          {inactiveTemplates.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-mid mb-2">Inactive</h4>
              {inactiveTemplates.map(t => (
                <div key={t.id} className="bg-un1t-dark/50 border border-un1t-gray/50 rounded-lg p-3 flex items-center justify-between opacity-60 mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="text-sm">{t.name} ({formatTime(t.start_time)}–{formatTime(t.end_time)})</span>
                  </div>
                  <button
                    onClick={async () => {
                      await fetch(`/api/schedule/templates/${t.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ active: true }),
                      })
                      fetchTemplates()
                    }}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Reactivate
                  </button>
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

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{template ? 'Edit Shift Template' : 'New Shift Template'}</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-un1t-light mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Morning, Afternoon, Evening"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-un1t-light mb-1">Start Time *</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
            </div>
            <div>
              <label className="block text-xs text-un1t-light mb-1">End Time *</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-un1t-light mb-1">Default Role / Position</label>
            <input
              type="text"
              value={roleLabel}
              onChange={e => setRoleLabel(e.target.value)}
              placeholder="e.g. Floor Coach, Front Desk (optional)"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>

          <div>
            <label className="block text-xs text-un1t-light mb-2">Colour</label>
            <div className="flex gap-2">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-full transition-transform ${color === c ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-un1t-dark' : 'hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={() => name && startTime && endTime && onSave({ name, start_time: startTime, end_time: endTime, color, role_label: roleLabel || null })}
          disabled={!name || !startTime || !endTime}
          className="w-full mt-5 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {template ? 'Save Changes' : 'Create Shift Template'}
        </button>
      </div>
    </div>
  )
}
