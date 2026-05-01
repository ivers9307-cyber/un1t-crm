'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Save, Plus, Trash2, ChevronDown, ChevronUp,
  Play, Pause, Clock, Mail, MessageCircle, Hourglass, Zap, AlertCircle
} from 'lucide-react'

const TRIGGER_TYPES = [
  { value: 'manual',          label: 'Manual Enrollment',    description: 'Manually add contacts to this sequence' },
  { value: 'booking_created', label: 'Booking Created',      description: 'Triggered when a contact makes a booking' },
  { value: 'status_change',   label: 'Status Change',        description: 'Triggered when lead status changes' },
  { value: 'event_reminder',  label: 'Event Reminder',       description: 'Triggered before an event starts' },
  { value: 'tag_added',       label: 'Tag Added',            description: 'Triggered when a tag is added to a contact' },
]

// Per-step icon/colour by channel.
const CHANNEL_CONFIG = {
  email:    { icon: Mail,          color: 'bg-blue-500/20 text-blue-400',   label: 'Email' },
  whatsapp: { icon: MessageCircle, color: 'bg-green-500/20 text-green-400', label: 'WhatsApp' },
  wait:     { icon: Hourglass,     color: 'bg-un1t-gray/40 text-un1t-light', label: 'Wait' },
}

// Pull {{1}}, {{2}}... placeholders out of a WhatsApp template's
// BODY component so we can render one input per variable.
function whatsappBodyVariables(template) {
  if (!template) return []
  const body = (template.components || []).find(c => c.type === 'BODY')
  if (!body?.text) return []
  const matches = body.text.match(/\{\{\d+\}\}/g) || []
  // Dedupe + sort numerically.
  const set = new Set(matches.map(m => m.match(/\d+/)[0]))
  return [...set].sort((a, b) => Number(a) - Number(b))
}

function StepCard({ step, index, onUpdate, onDelete, onMoveUp, onMoveDown, isFirst, isLast, whatsappTemplates }) {
  const [expanded, setExpanded] = useState(false)
  const stepType = step.step_type || 'email'
  const config = CHANNEL_CONFIG[stepType] || CHANNEL_CONFIG.email
  const StepIcon = config.icon

  const selectedWaTemplate = stepType === 'whatsapp' && step.whatsapp_template_id
    ? whatsappTemplates.find(t => t.id === step.whatsapp_template_id)
    : null
  const waVariables = selectedWaTemplate ? whatsappBodyVariables(selectedWaTemplate) : []

  // Header label depends on channel.
  let headerLabel
  if (stepType === 'wait') headerLabel = `Wait ${step.delay_days || 0}d ${step.delay_hours || 0}h`
  else if (stepType === 'whatsapp') headerLabel = selectedWaTemplate?.name || `WhatsApp step ${index + 1}`
  else headerLabel = step.subject || `Step ${index + 1}`

  return (
    <div className="relative">
      {!isFirst && <div className="absolute left-6 -top-4 w-px h-4 bg-un1t-gray" />}

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        {/* Step header */}
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-un1t-gray/20 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-1 text-un1t-mid">
            <button onClick={e => { e.stopPropagation(); onMoveUp() }} disabled={isFirst} className="p-0.5 hover:text-un1t-white disabled:opacity-30">
              <ChevronUp size={12} />
            </button>
            <button onClick={e => { e.stopPropagation(); onMoveDown() }} disabled={isLast} className="p-0.5 hover:text-un1t-white disabled:opacity-30">
              <ChevronDown size={12} />
            </button>
          </div>

          <div className={`w-8 h-8 rounded-full ${config.color} flex items-center justify-center`}>
            <StepIcon size={14} />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{headerLabel}</p>
            <p className="text-xs text-un1t-mid">
              <Clock size={10} className="inline mr-1" />
              Wait {step.delay_days || 0}d {step.delay_hours || 0}h
              {stepType !== 'wait' && ' then send'}
              {' · '}{config.label}
            </p>
          </div>

          <button onClick={e => { e.stopPropagation(); onDelete() }} className="p-1.5 text-un1t-mid hover:text-red-400">
            <Trash2 size={14} />
          </button>

          {expanded ? <ChevronUp size={16} className="text-un1t-light" /> : <ChevronDown size={16} className="text-un1t-light" />}
        </div>

        {expanded && (
          <div className="border-t border-un1t-gray p-4 space-y-4">
            {/* Channel + delay row */}
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-un1t-light mb-1">Channel</label>
                <select
                  value={stepType}
                  onChange={e => onUpdate({ step_type: e.target.value })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                >
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="wait">Wait (delay only)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-un1t-light mb-1">Delay (days)</label>
                <input
                  type="number"
                  min="0"
                  value={step.delay_days || 0}
                  onChange={e => onUpdate({ delay_days: parseInt(e.target.value) || 0 })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid w-20"
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
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid w-20"
                />
              </div>
              <p className="text-xs text-un1t-mid pb-2">
                {index === 0 ? 'after enrollment' : 'after previous step'}
              </p>
            </div>

            {/* Email step content */}
            {stepType === 'email' && (
              <>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Subject Line</label>
                  <input
                    type="text"
                    value={step.subject || ''}
                    onChange={e => onUpdate({ subject: e.target.value })}
                    placeholder="Email subject — use {{first_name}} for personalisation"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                  />
                </div>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Email HTML</label>
                  <textarea
                    value={step.html_content || ''}
                    onChange={e => onUpdate({ html_content: e.target.value })}
                    placeholder="Paste your HTML email content here..."
                    rows={8}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-green-400 font-mono placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid resize-y"
                  />
                  <p className="text-xs text-un1t-mid mt-1">
                    Merge tags: {'{{first_name}}'}, {'{{name}}'}, {'{{email}}'}, {'{{unsubscribe_url}}'}
                  </p>
                </div>
              </>
            )}

            {/* WhatsApp step content */}
            {stepType === 'whatsapp' && (
              <>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">WhatsApp Template (Meta-approved)</label>
                  <select
                    value={step.whatsapp_template_id || ''}
                    onChange={e => onUpdate({
                      whatsapp_template_id: e.target.value || null,
                      whatsapp_variables: {}, // reset on template change
                    })}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                  >
                    <option value="">— Select a template —</option>
                    {whatsappTemplates.map(t => (
                      <option key={t.id} value={t.id} disabled={t.status !== 'APPROVED'}>
                        {t.name} ({t.language}, {t.status})
                      </option>
                    ))}
                  </select>
                  {whatsappTemplates.length === 0 && (
                    <p className="mt-1 text-[11px] text-amber-500 inline-flex items-center gap-1">
                      <AlertCircle size={11} /> No WhatsApp templates yet — create one under Communications → Templates first.
                    </p>
                  )}
                </div>

                {selectedWaTemplate && (
                  <div className="bg-un1t-black/50 border border-un1t-gray rounded-md p-3 space-y-2">
                    <p className="text-[11px] uppercase tracking-wider text-un1t-light">Template body preview</p>
                    <p className="text-xs text-un1t-mid whitespace-pre-wrap">
                      {(selectedWaTemplate.components || []).find(c => c.type === 'BODY')?.text || '(no body text)'}
                    </p>
                  </div>
                )}

                {waVariables.length > 0 && (
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Variable mapping</label>
                    <p className="text-[11px] text-un1t-mid mb-2">
                      Type a contact field name (<code>first_name</code>, <code>name</code>, <code>email</code>, <code>phone</code>) or a literal value.
                    </p>
                    <div className="space-y-2">
                      {waVariables.map(num => (
                        <div key={num} className="flex items-center gap-2">
                          <span className="text-xs text-un1t-light w-12">{`{{${num}}}`}</span>
                          <input
                            type="text"
                            value={(step.whatsapp_variables || {})[num] || ''}
                            onChange={e => onUpdate({
                              whatsapp_variables: {
                                ...(step.whatsapp_variables || {}),
                                [num]: e.target.value,
                              },
                            })}
                            placeholder={num === '1' ? 'e.g. first_name' : 'field name or literal text'}
                            className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Wait step has no content beyond the delay configured above. */}
            {stepType === 'wait' && (
              <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3">
                <p className="text-xs text-un1t-light">
                  Wait steps just hold the contact for the delay above before the next step fires. Useful between channels (e.g. WhatsApp → wait 2 days → email follow-up).
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function SequenceEditor({ sequence, locationId, userId }) {

  const [name, setName] = useState(sequence?.name || '')
  const [description, setDescription] = useState(sequence?.description || '')
  const [triggerType, setTriggerType] = useState(sequence?.trigger_type || 'manual')
  const [triggerConfig, setTriggerConfig] = useState(sequence?.trigger_config || {})
  const [status, setStatus] = useState(sequence?.status || 'draft')
  const [steps, setSteps] = useState(sequence?.sequence_steps || [])
  const [whatsappTemplates, setWhatsappTemplates] = useState([])

  // Lazy-load the location's WhatsApp templates so the StepCard
  // can offer a dropdown when a step is set to channel=whatsapp.
  // Templates are tied to a single location via location_id, so no
  // need to refetch when individual steps change.
  useEffect(() => {
    if (!locationId) return
    fetch(`/api/whatsapp/templates?location_id=${locationId}`)
      .then(r => r.ok ? r.json() : { success: false })
      .then(j => {
        if (j.success && Array.isArray(j.data)) setWhatsappTemplates(j.data)
        else if (j.success && Array.isArray(j.templates)) setWhatsappTemplates(j.templates)
      })
      .catch(() => {})
  }, [locationId])
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
      step_type: 'email',
      subject: '',
      html_content: '',
      whatsapp_variables: {},
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

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray bg-un1t-dark shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/email/sequences" className="text-un1t-light hover:text-un1t-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Sequence name..."
            className="bg-transparent text-lg font-semibold text-un1t-white placeholder:text-un1t-mid focus:outline-none w-64"
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
            className="flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
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
                      ? 'border-un1t-white bg-un1t-gray/30'
                      : 'border-un1t-gray hover:border-un1t-white/30'
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
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
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
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid w-64"
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
                    className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid w-20"
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
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
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
                  whatsappTemplates={whatsappTemplates}
                />
              ))}
            </div>

            <button
              onClick={addStep}
              className="flex items-center gap-2 mt-4 text-sm text-un1t-light hover:text-un1t-white border border-dashed border-un1t-gray hover:border-un1t-white/30 px-4 py-2.5 rounded-lg w-full justify-center transition-colors"
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
