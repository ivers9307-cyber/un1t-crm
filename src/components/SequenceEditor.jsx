'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Save, Plus, Trash2, ChevronDown, ChevronUp,
  Play, Pause, Clock, Mail, Zap, GripVertical
} from 'lucide-react'

const TRIGGER_TYPES = [
  { value: 'manual',          label: 'Manual Enrollment',    description: 'Manually add contacts to this sequence' },
  { value: 'booking_created', label: 'Booking Created',      description: 'Triggered when a contact makes a booking' },
  { value: 'status_change',   label: 'Status Change',        description: 'Triggered when lead status changes' },
  { value: 'event_reminder',  label: 'Event Reminder',       description: 'Triggered before an event starts' },
  { value: 'tag_added',       label: 'Tag Added',            description: 'Triggered when a tag is added to a contact' },
]

function StepCard({ step, index, onUpdate, onDelete, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="relative">
      {/* Connector line */}
      {!isFirst && (
        <div className="absolute left-6 -top-4 w-px h-4 bg-un1t-gray" />
      )}

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        {/* Step header */}
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-un1t-gray/20 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-1 text-un1t-mid">
            <button
              onClick={e => { e.stopPropagation(); onMoveUp() }}
              disabled={isFirst}
              className="p-0.5 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ChevronUp size={12} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); onMoveDown() }}
              disabled={isLast}
              className="p-0.5 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ChevronDown size={12} />
            </button>
          </div>

          <div className="w-8 h-8 rounded-full bg-un1t-gray/30 flex items-center justify-center text-xs font-bold text-un1t-light">
            {index + 1}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {step.subject || `Step ${index + 1}`}
            </p>
            <p className="text-xs text-un1t-mid">
              <Clock size={10} className="inline mr-1" />
              Wait {step.delay_days || 0}d {step.delay_hours || 0}h then send
            </p>
          </div>

          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="p-1.5 text-un1t-mid hover:text-red-400 transition-colors"
          >
            <Trash2 size={14} />
          </button>

          {expanded ? <ChevronUp size={16} className="text-un1t-light" /> : <ChevronDown size={16} className="text-un1t-light" />}
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="border-t border-un1t-gray p-4 space-y-4">
            {/* Delay */}
            <div className="flex items-center gap-4">
              <div>
                <label className="block text-xs text-un1t-light mb-1">Delay (days)</label>
                <input
                  type="number"
                  min="0"
                  value={step.delay_days || 0}
                  onChange={e => onUpdate({ delay_days: parseInt(e.target.value) || 0 })}
                  className="bg-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-white/40 w-20"
                />
              </div>
              <div>
                <label className="block text-xs text-un1t-light mb-1">Hours</label>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={step.delay_hours || 0}
                  onChange={e => onUpdate({ delay_hours: parseInt(e.target.value) || 0 })}
                  className="bg-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-white/40 w-20"
                />
              </div>
              <p className="text-xs text-un1t-mid mt-5">
                {index === 0 ? 'after enrollment' : 'after previous step'}
              </p>
            </div>

            {/* Subject */}
            <div>
              <label className="block text-xs text-un1t-light mb-1">Subject Line</label>
              <input
                type="text"
                value={step.subject || ''}
                onChange={e => onUpdate({ subject: e.target.value })}
                placeholder="Email subject — use {{first_name}} for personalisation"
                className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
              />
            </div>

            {/* HTML Content */}
            <div>
              <label className="block text-xs text-un1t-light mb-1">Email HTML</label>
              <textarea
                value={step.html_content || ''}
                onChange={e => onUpdate({ html_content: e.target.value })}
                placeholder="Paste your HTML email content here..."
                rows={8}
                className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-green-400 font-mono placeholder:text-un1t-mid focus:outline-none focus:border-white/40 resize-y"
              />
              <p className="text-xs text-un1t-mid mt-1">
                Merge tags: {'{{first_name}}'}, {'{{name}}'}, {'{{email}}'}, {'{{unsubscribe_url}}'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function SequenceEditor({ sequence, locationId, userId }) {
  const router = useRouter()
  const isEditing = !!sequence

  const [name, setName] = useState(sequence?.name || '')
  const [description, setDescription] = useState(sequence?.description || '')
  const [triggerType, setTriggerType] = useState(sequence?.trigger_type || 'manual')
  const [triggerConfig, setTriggerConfig] = useState(sequence?.trigger_config || {})
  const [status, setStatus] = useState(sequence?.status || 'draft')
  const [steps, setSteps] = useState(sequence?.sequence_steps || [])
  const [sequenceId, setSequenceId] = useState(sequence?.id || null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      // Save sequence
      const seqPayload = {
        name: name || 'Untitled Sequence',
        description,
        trigger_type: triggerType,
        trigger_config: triggerConfig,
        status,
        location_id: locationId,
        created_by: userId,
      }

      let seqResult
      if (sequenceId) {
        seqResult = await fetch(`/api/sequences/${sequenceId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(seqPayload),
        }).then(r => r.json())
      } else {
        seqResult = await fetch('/api/sequences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(seqPayload),
        }).then(r => r.json())
      }

      if (!seqResult.success) throw new Error(seqResult.error)

      const currentSeqId = sequenceId || seqResult.sequence?.id
      if (!sequenceId && currentSeqId) {
        setSequenceId(currentSeqId)
        window.history.replaceState(null, '', `/email/sequences/${currentSeqId}`)
      }

      // Save steps — for new steps (no id), POST. For existing, bulk PUT.
      const existingSteps = steps.filter(s => s.id)
      const newSteps = steps.filter(s => !s.id)

      if (existingSteps.length > 0) {
        await fetch(`/api/sequences/${currentSeqId}/steps`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps: existingSteps }),
        })
      }

      for (const step of newSteps) {
        const res = await fetch(`/api/sequences/${currentSeqId}/steps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(step),
        }).then(r => r.json())

        if (res.success && res.step) {
          // Update local state with server-assigned ID
          setSteps(prev => prev.map(s => s === step ? { ...s, id: res.step.id } : s))
        }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function addStep() {
    const nextOrder = steps.length + 1
    setSteps([...steps, {
      step_order: nextOrder,
      delay_days: nextOrder === 1 ? 0 : 1,
      delay_hours: 0,
      subject: '',
      html_content: '',
    }])
  }

  function updateStep(index, updates) {
    setSteps(steps.map((s, i) => i === index ? { ...s, ...updates } : s))
  }

  function deleteStep(index) {
    const step = steps[index]
    if (step.id) {
      // Delete from server
      fetch(`/api/sequences/${sequenceId}/steps/${step.id}`, { method: 'DELETE' })
    }
    const updated = steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_order: i + 1 }))
    setSteps(updated)
  }

  function moveStep(index, direction) {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= steps.length) return
    const updated = [...steps]
    const temp = updated[index]
    updated[index] = updated[newIndex]
    updated[newIndex] = temp
    setSteps(updated.map((s, i) => ({ ...s, step_order: i + 1 })))
  }

  async function toggleActive() {
    const newStatus = status === 'active' ? 'paused' : 'active'
    setStatus(newStatus)
    if (sequenceId) {
      await fetch(`/api/sequences/${sequenceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
    }
  }

  const selectedTrigger = TRIGGER_TYPES.find(t => t.value === triggerType)

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray bg-un1t-dark shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/email/sequences" className="text-un1t-light hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Sequence name..."
            className="bg-transparent text-lg font-semibold text-white placeholder:text-un1t-mid focus:outline-none w-64"
          />
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            status === 'active' ? 'bg-green-500/20 text-green-400' :
            status === 'paused' ? 'bg-yellow-500/20 text-yellow-400' :
            'bg-gray-500/20 text-gray-400'
          }`}>
            {status}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {sequenceId && status !== 'draft' && (
            <button
              onClick={toggleActive}
              className={`flex items-center gap-1.5 text-sm border px-3 py-1.5 rounded-md transition-colors ${
                status === 'active'
                  ? 'border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10'
                  : 'border-green-500/50 text-green-400 hover:bg-green-500/10'
              }`}
            >
              {status === 'active' ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Activate</>}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 text-sm bg-white text-black font-medium px-4 py-1.5 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Trigger config */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
              <Zap size={14} className="inline mr-1.5" />
              Trigger
            </h3>
            <p className="text-xs text-un1t-mid mb-4">What causes contacts to enter this sequence?</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {TRIGGER_TYPES.map(t => (
                <button
                  key={t.value}
                  onClick={() => setTriggerType(t.value)}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    triggerType === t.value
                      ? 'border-white bg-white/5'
                      : 'border-un1t-gray hover:border-white/30'
                  }`}
                >
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-un1t-mid mt-0.5">{t.description}</p>
                </button>
              ))}
            </div>

            {/* Trigger-specific config */}
            {triggerType === 'status_change' && (
              <div className="mt-4">
                <label className="block text-xs text-un1t-light mb-1">Trigger when status changes to:</label>
                <select
                  value={triggerConfig.to_status || ''}
                  onChange={e => setTriggerConfig({ ...triggerConfig, to_status: e.target.value })}
                  className="bg-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-white/40"
                >
                  <option value="">Any status</option>
                  <option value="active_trial">Active Trial</option>
                  <option value="member">Member</option>
                  <option value="cold">Cold</option>
                  <option value="lost_member">Lost Member</option>
                  <option value="returning">Returning</option>
                </select>
              </div>
            )}

            {triggerType === 'tag_added' && (
              <div className="mt-4">
                <label className="block text-xs text-un1t-light mb-1">Trigger when tag is added:</label>
                <input
                  type="text"
                  value={triggerConfig.tag || ''}
                  onChange={e => setTriggerConfig({ ...triggerConfig, tag: e.target.value })}
                  placeholder="e.g. new_member, trial_expired"
                  className="bg-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40 w-64"
                />
              </div>
            )}

            {triggerType === 'event_reminder' && (
              <div className="mt-4">
                <label className="block text-xs text-un1t-light mb-1">Send reminder before event:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={triggerConfig.hours_before || 24}
                    onChange={e => setTriggerConfig({ ...triggerConfig, hours_before: parseInt(e.target.value) || 24 })}
                    className="bg-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-white/40 w-20"
                  />
                  <span className="text-xs text-un1t-mid">hours before</span>
                </div>
              </div>
            )}
          </div>

          {/* Description */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <label className="block text-xs text-un1t-light mb-1.5">Description (internal)</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What is this sequence for?"
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
            />
          </div>

          {/* Steps */}
          <div>
            <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
              <Mail size={14} className="inline mr-1.5" />
              Steps ({steps.length})
            </h3>

            {steps.length === 0 && (
              <div className="bg-un1t-dark border border-dashed border-un1t-gray rounded-lg p-8 text-center">
                <Mail size={28} className="mx-auto mb-2 text-un1t-mid" />
                <p className="text-sm text-un1t-light mb-1">No steps yet</p>
                <p className="text-xs text-un1t-mid">Add your first email step below</p>
              </div>
            )}

            <div className="space-y-4 mt-3">
              {steps.map((step, index) => (
                <StepCard
                  key={step.id || `new-${index}`}
                  step={step}
                  index={index}
                  onUpdate={(updates) => updateStep(index, updates)}
                  onDelete={() => deleteStep(index)}
                  onMoveUp={() => moveStep(index, -1)}
                  onMoveDown={() => moveStep(index, 1)}
                  isFirst={index === 0}
                  isLast={index === steps.length - 1}
                />
              ))}
            </div>

            <button
              onClick={addStep}
              className="flex items-center gap-2 mt-4 text-sm text-un1t-light hover:text-white border border-dashed border-un1t-gray hover:border-white/30 px-4 py-2.5 rounded-lg w-full justify-center transition-colors"
            >
              <Plus size={16} />
              Add Step
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
