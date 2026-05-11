'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Save, Plus, Trash2, ChevronDown, ChevronUp,
  Play, Pause, Clock, Mail, MessageCircle, MessageSquare, Hourglass, Zap, AlertCircle, GitBranch
} from 'lucide-react'

const TRIGGER_TYPES = [
  { value: 'manual',           label: 'Manual Enrollment',  description: 'Manually add contacts to this sequence' },
  { value: 'booking_created',  label: 'Booking Created',    description: 'Triggered when a contact makes a booking' },
  { value: 'first_booking',    label: 'First Booking',      description: 'Triggered ONLY on the contact\'s very first booking — perfect for welcome series' },
  { value: 'status_change',    label: 'Status Change',      description: 'Triggered when lead status changes' },
  { value: 'event_reminder',   label: 'Event Reminder',     description: 'Triggered before an event starts' },
  { value: 'tag_added',        label: 'Tag Added',          description: 'Triggered when a tag is added to a contact' },
  { value: 'race_registered',  label: 'Race Registered',    description: 'Triggered when a team signs up for a race — fires for every team member' },
  { value: 'race_finished',    label: 'Race Finished',      description: 'Triggered when an operator marks a team done at the finish line' },
  { value: 'order_completed',  label: 'Order Completed',    description: 'Triggered when a paid order (race or car deposit) lands' },
  { value: 'order_failed',     label: 'Order Failed',       description: 'Triggered when a payment fails — perfect for retry-recovery' },
  { value: 'order_abandoned',  label: 'Order Abandoned',    description: 'Triggered when a buyer abandons checkout — cart-recovery sequences' },
  { value: 'anniversary',      label: 'Anniversary',        description: 'Triggered N days after a contact field (lead_created_at, last_emailed_at)' },
  { value: 'inactivity',       label: 'Inactivity',         description: 'Triggered when a contact has been inactive for N days — win-back sequences' },
  { value: 'achievement_unlocked', label: 'Achievement Unlocked', description: 'Triggered when a member earns a heart-rate achievement. Optional rule_slug filter targets a specific badge.' },
  // FLOW2 (mig 131) — inbound webhook trigger. External systems
  // (n8n / Glofox / Stripe / Zapier) POST to a unique URL to enrol
  // a contact. URL + optional secret rendered in the panel below.
  { value: 'webhook',          label: 'Webhook (inbound)',  description: 'Triggered when an external system POSTs to a unique URL. Use to wire n8n / Glofox / Stripe / Zapier into this sequence.' },
]

// Per-step icon/colour by channel.
const CHANNEL_CONFIG = {
  email:    { icon: Mail,          color: 'bg-blue-500/20 text-blue-400',   label: 'Email' },
  whatsapp: { icon: MessageCircle, color: 'bg-green-500/20 text-green-400', label: 'WhatsApp' },
  sms:      { icon: MessageSquare, color: 'bg-cyan-500/20 text-cyan-400',   label: 'SMS' },
  wait:     { icon: Hourglass,     color: 'bg-un1t-gray/40 text-un1t-light', label: 'Wait' },
  branch:   { icon: GitBranch,     color: 'bg-purple-500/20 text-purple-700', label: 'Branch' },
}

// Same segment math used by SMSBroadcastEditor — single GSM7
// fits 160 chars; multi-segment is 153 per segment.
function smsSegmentInfo(text) {
  const len = text?.length || 0
  if (len === 0) return { len: 0, segments: 0 }
  if (len <= 160) return { len, segments: 1 }
  return { len, segments: Math.ceil(len / 153) }
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

function StepCard({ step, index, onUpdate, onDelete, onMoveUp, onMoveDown, isFirst, isLast, whatsappTemplates, stats }) {
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
  else if (stepType === 'sms') headerLabel = (step.sms_body && step.sms_body.length > 40 ? step.sms_body.slice(0, 40) + '…' : step.sms_body) || `SMS step ${index + 1}`
  else if (stepType === 'branch') {
    // Mig 091: render the predicate inline so the operator can see
    // the shape without expanding.
    const p = step.config?.predicate
    if (p?.type === 'has_tag' && p.tag) headerLabel = `Branch: has tag "${p.tag}"`
    else if (p?.type === 'field_equals' && p.field) headerLabel = `Branch: ${p.field} = ${JSON.stringify(p.value ?? '')}`
    else if (p?.type === 'field_in' && p.field) headerLabel = `Branch: ${p.field} ∈ […]`
    else headerLabel = `Branch (predicate not configured)`
  }
  else headerLabel = step.subject || `Step ${index + 1}`

  const smsSeg = stepType === 'sms' ? smsSegmentInfo(step.sms_body || '') : null

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

          {/* Tier 3A: per-step stats badge. Only renders when we
              have data — saved-step-with-sends. Compact pill so it
              fits the header. */}
          {stats && stats.sent > 0 && (
            <div className="hidden md:flex items-center gap-3 text-[11px] text-un1t-light">
              <span title="Sent" className="tabular-nums">{stats.sent} sent</span>
              {stepType === 'email' && (
                <>
                  <span title="Open rate" className="tabular-nums text-emerald-700">
                    {Math.round((stats.opened / stats.sent) * 100)}% open
                  </span>
                  <span title="Click rate" className="tabular-nums text-blue-700">
                    {Math.round((stats.clicked / stats.sent) * 100)}% click
                  </span>
                  {stats.bounced > 0 && (
                    <span title="Bounces" className="tabular-nums text-red-700">
                      {stats.bounced} bounced
                    </span>
                  )}
                </>
              )}
            </div>
          )}

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
                  <option value="sms">SMS</option>
                  <option value="wait">Wait (delay only)</option>
                  <option value="apply_tag">Apply tag</option>
                  <option value="update_field">Update field</option>
                  <option value="internal_task">Create internal task</option>
                  <option value="webhook">Webhook (HTTPS)</option>
                  <option value="branch">Branch (if / else)</option>
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

            {/* SMS step (mig 062). Freeform body sent via Twilio,
                using the sequence's location's per-location alpha
                sender ID (mig 059). Same merge tags as email + ad-hoc. */}
            {stepType === 'sms' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs text-un1t-light">SMS body</label>
                  {smsSeg && (
                    <span className={`text-[11px] ${smsSeg.segments > 1 ? 'text-amber-500' : 'text-un1t-light'}`}>
                      {smsSeg.len} chars · {smsSeg.segments} segment{smsSeg.segments === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <textarea
                  value={step.sms_body || ''}
                  onChange={e => onUpdate({ sms_body: e.target.value })}
                  rows={4}
                  maxLength={1600}
                  placeholder="Hi {{first_name}}, just a reminder your trial expires in 2 days at {{location_name}}."
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid resize-y"
                />
                <p className="text-[11px] text-un1t-mid">
                  Merge tags: <code className="text-un1t-light">{'{{first_name}}'}</code>, <code className="text-un1t-light">{'{{name}}'}</code>, <code className="text-un1t-light">{'{{location_name}}'}</code>. Sender ID is set per-location in <Link href="/settings" className="underline">Location Settings</Link>.
                </p>
              </div>
            )}

            {/* Wait step has no content beyond the delay configured above. */}
            {stepType === 'wait' && (
              <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3">
                <p className="text-xs text-un1t-light">
                  Wait steps just hold the contact for the delay above before the next step fires. Useful between channels (e.g. WhatsApp → wait 2 days → email follow-up).
                </p>
              </div>
            )}

            {/* apply_tag step (mig 087). Tags this contact with the
                specified retargeting tag. Composable with Tag Added
                trigger on a different sequence. */}
            {stepType === 'apply_tag' && (
              <div className="space-y-2">
                <label className="block text-xs text-un1t-light">Tag to apply</label>
                <input
                  type="text"
                  value={step.config?.tag || ''}
                  onChange={e => onUpdate({ config: { ...(step.config || {}), tag: e.target.value } })}
                  placeholder="e.g. engaged_competitor"
                  maxLength={60}
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                />
                <p className="text-[11px] text-un1t-mid">
                  Lower-case + underscores recommended. Lets a different sequence with trigger=&quot;Tag Added&quot; pick this contact up.
                </p>
              </div>
            )}

            {/* update_field step (mig 087). Whitelisted fields only —
                runner enforces the same allowlist server-side. */}
            {stepType === 'update_field' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Field</label>
                    <select
                      value={step.config?.field || 'lead_status'}
                      onChange={e => onUpdate({ config: { ...(step.config || {}), field: e.target.value } })}
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                    >
                      <option value="lead_status">lead_status</option>
                      <option value="label">label</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Value</label>
                    {(step.config?.field || 'lead_status') === 'lead_status' ? (
                      <select
                        value={step.config?.value || ''}
                        onChange={e => onUpdate({ config: { ...(step.config || {}), value: e.target.value } })}
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                      >
                        <option value="">(pick one)</option>
                        <option value="active_trial">active_trial</option>
                        <option value="cold">cold</option>
                        <option value="lost_member">lost_member</option>
                        <option value="member">member</option>
                        <option value="returning">returning</option>
                        <option value="competition_competitor">competition_competitor</option>
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={step.config?.value || ''}
                        onChange={e => onUpdate({ config: { ...(step.config || {}), value: e.target.value } })}
                        placeholder="Value"
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                      />
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-un1t-mid">
                  Useful to graduate a contact between buckets (e.g. competition_competitor → returning) when they hit a milestone. Setting lead_status will fire the Status Change trigger so other sequences can chain off it.
                </p>
              </div>
            )}

            {/* internal_task step (mig 087). Creates an activity row
                that shows up on the contact's open tasks + the staff
                task inbox. */}
            {stepType === 'internal_task' && (
              <div className="space-y-2">
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Task subject</label>
                  <input
                    type="text"
                    value={step.config?.subject || ''}
                    onChange={e => onUpdate({ config: { ...(step.config || {}), subject: e.target.value } })}
                    placeholder="e.g. Follow up with this race competitor"
                    maxLength={200}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                  />
                </div>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Note (optional)</label>
                  <textarea
                    value={step.config?.note || ''}
                    onChange={e => onUpdate({ config: { ...(step.config || {}), note: e.target.value } })}
                    rows={3}
                    placeholder="Context for whoever picks this up…"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                  />
                </div>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Due (minutes from now)</label>
                  <input
                    type="number"
                    min="0"
                    value={step.config?.due_offset_minutes ?? 0}
                    onChange={e => onUpdate({ config: { ...(step.config || {}), due_offset_minutes: parseInt(e.target.value) || 0 } })}
                    className="w-32 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                  />
                </div>
                <p className="text-[11px] text-un1t-mid">
                  Task lands unassigned by default — staff pick it up from the activities queue. Pair with a Wait step before to delay the task.
                </p>
              </div>
            )}

            {/* webhook step (mig 089). HTTPS only, no signing — pass
                an Authorization header in config.headers if your
                endpoint needs it. */}
            {stepType === 'webhook' && (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">URL (https only)</label>
                    <input
                      type="url"
                      value={step.config?.url || ''}
                      onChange={e => onUpdate({ config: { ...(step.config || {}), url: e.target.value } })}
                      placeholder="https://hook.example.com/un1t-sequence"
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Method</label>
                    <select
                      value={step.config?.method || 'POST'}
                      onChange={e => onUpdate({ config: { ...(step.config || {}), method: e.target.value } })}
                      className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                    >
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="PATCH">PATCH</option>
                      <option value="GET">GET</option>
                      <option value="DELETE">DELETE</option>
                    </select>
                  </div>
                </div>
                <p className="text-[11px] text-un1t-mid">
                  Default payload includes contact + sequence + enrolment context. To override, supply a custom payload object via the API. For auth, include an <code>Authorization</code> header in <code>config.headers</code>.
                </p>
              </div>
            )}

            {/* branch step (mig 091 / Tier 3E). Predicate selects one
                of two continuation step orders. Defaults are sensible
                ("if matched proceed normally, otherwise skip 1 step")
                so the operator can leave the pointers blank for the
                most common shape. */}
            {stepType === 'branch' && (() => {
              const cfg = step.config || {}
              const predicate = cfg.predicate || { type: 'has_tag' }
              const ownOrder = step.step_order || (index + 1)
              const setPredicate = (next) => onUpdate({
                config: { ...cfg, predicate: { ...predicate, ...next } },
              })
              const setPointer = (key, raw) => {
                const v = raw === '' ? null : parseInt(raw)
                onUpdate({ config: { ...cfg, [key]: Number.isFinite(v) ? v : null } })
              }
              return (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">If predicate is…</label>
                    <select
                      value={predicate.type || 'has_tag'}
                      onChange={e => setPredicate({ type: e.target.value })}
                      className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                    >
                      <option value="has_tag">Has tag</option>
                      <option value="field_equals">Field equals</option>
                      <option value="field_in">Field is one of</option>
                    </select>
                  </div>

                  {predicate.type === 'has_tag' && (
                    <div>
                      <label className="block text-xs text-un1t-light mb-1">Tag</label>
                      <input
                        type="text"
                        value={predicate.tag || ''}
                        onChange={e => setPredicate({ tag: e.target.value })}
                        placeholder="e.g. race_completed"
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                      />
                    </div>
                  )}

                  {(predicate.type === 'field_equals' || predicate.type === 'field_in') && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-un1t-light mb-1">Field</label>
                        <select
                          value={predicate.field || 'lead_status'}
                          onChange={e => setPredicate({ field: e.target.value })}
                          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                        >
                          <option value="lead_status">lead_status</option>
                          <option value="label">label</option>
                          <option value="email_status">email_status</option>
                          <option value="sms_status">sms_status</option>
                          <option value="marketing_opt_in">marketing_opt_in</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-un1t-light mb-1">
                          {predicate.type === 'field_in' ? 'Values (comma-sep)' : 'Value'}
                        </label>
                        {predicate.type === 'field_in' ? (
                          <input
                            type="text"
                            value={Array.isArray(predicate.values) ? predicate.values.join(', ') : ''}
                            onChange={e => setPredicate({
                              values: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                            })}
                            placeholder="member, returning"
                            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                          />
                        ) : (
                          <input
                            type="text"
                            value={predicate.value ?? ''}
                            onChange={e => setPredicate({ value: e.target.value })}
                            placeholder="member"
                            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                          />
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-un1t-light mb-1">Then jump to step</label>
                      <input
                        type="number"
                        min={ownOrder + 1}
                        value={cfg.then_step_order ?? ''}
                        onChange={e => setPointer('then_step_order', e.target.value)}
                        placeholder={`${ownOrder + 1} (next step)`}
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-un1t-light mb-1">Else jump to step</label>
                      <input
                        type="number"
                        min={ownOrder + 1}
                        value={cfg.else_step_order ?? ''}
                        onChange={e => setPointer('else_step_order', e.target.value)}
                        placeholder={`${ownOrder + 2} (skip 1)`}
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                      />
                    </div>
                  </div>

                  <p className="text-[11px] text-un1t-mid">
                    Branch steps don&apos;t send anything — they reroute the contact based on a check. Step orders must be greater than this branch&apos;s own order ({ownOrder}); the runner refuses backwards jumps to keep enrolments from looping.
                  </p>
                </div>
              )
            })()}
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
  const [goalConfig, setGoalConfig] = useState(sequence?.goal_config || null)
  const [sendWindow, setSendWindow] = useState(sequence?.send_window || null)
  // Mig 090 / Tier 3C. NULL or '' = single-enrolment-per-contact.
  // Empty-string state lets the input render cleanly when unset.
  const [reEnrolCooldown, setReEnrolCooldown] = useState(
    sequence?.re_enrolment_cooldown_days ?? ''
  )
  // FLOW2 (mig 131) — inbound webhook token + optional shared
  // secret. Token is auto-generated server-side when the sequence
  // first saves with trigger_type='webhook'; operator can rotate
  // via the "Regenerate" button below. Secret is operator-managed
  // (NULL = token-in-URL is the only auth).
  const [webhookToken, setWebhookToken] = useState(sequence?.webhook_token || null)
  const [webhookSecret, setWebhookSecret] = useState(sequence?.webhook_secret || '')
  const [webhookSecretInput, setWebhookSecretInput] = useState('')
  const [webhookBusy, setWebhookBusy] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState(false)
  const [stats, setStats] = useState(null) // mig 088 / Tier 3A
  const [status, setStatus] = useState(sequence?.status || 'draft')
  const [steps, setSteps] = useState(sequence?.sequence_steps || [])
  const [testStatus, setTestStatus] = useState(null) // { ok, message }
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

  // Fetch per-step + enrolment stats once on load (Tier 3A).
  // Re-fetched after operator clicks 'Send test' so the updated
  // enrolment count surfaces. Skipped for unsaved sequences.
  useEffect(() => {
    if (!sequenceId) return
    fetch(`/api/sequences/${sequenceId}/stats`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j?.success) setStats(j.data) })
      .catch(() => {})
  }, [sequenceId])
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
        goal_config: goalConfig,
        send_window: sendWindow,
        re_enrolment_cooldown_days:
          reEnrolCooldown === '' || reEnrolCooldown === null
            ? null
            : Math.max(0, Math.min(3650, parseInt(reEnrolCooldown))),
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
      // FLOW2 — save may have generated a webhook_token (when the
      // operator switched trigger_type to 'webhook'). Pull it from
      // the response so the URL panel renders without a refresh.
      if (seqResult.sequence?.webhook_token && !webhookToken) {
        setWebhookToken(seqResult.sequence.webhook_token)
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
          {sequenceId && (
            <button
              onClick={async () => {
                setTestStatus(null)
                try {
                  const r = await fetch(`/api/sequences/${sequenceId}/test`, { method: 'POST' })
                  const j = await r.json()
                  if (!r.ok || j.success === false) {
                    setTestStatus({ ok: false, message: j.error || `Test failed (${r.status})` })
                  } else {
                    setTestStatus({ ok: true, message: j.data?.message || 'Test enrolment created.' })
                  }
                } catch (e) {
                  setTestStatus({ ok: false, message: e.message || 'Network error' })
                }
              }}
              className="flex items-center gap-1.5 text-sm border border-un1t-gray text-un1t-light hover:text-un1t-white px-3 py-1.5 rounded-md"
              title="Enrol your own contact with delays accelerated to 60s — preview every step in a couple of minutes"
            >
              <Zap size={14} /> Send test
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

      {testStatus && (
        <div className={`text-sm px-5 py-2 border-b ${testStatus.ok
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700'
          : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
          {testStatus.message}
        </div>
      )}

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

            {/* FLOW2 (mig 131) — webhook trigger config panel.
                Shows the operator's unique inbound URL + optional
                shared secret + an example curl. Token is generated
                server-side on first save with trigger_type='webhook'
                so before that we show a "save first" hint instead. */}
            {triggerType === 'webhook' && (
              <div className="mt-4 space-y-3">
                {!webhookToken ? (
                  <div className="bg-un1t-black border border-un1t-gray rounded-md p-3 text-xs text-un1t-light">
                    Save the sequence first — we&apos;ll generate a unique webhook URL for it.
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs text-un1t-light mb-1">Webhook URL (POST JSON to this)</label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-xs text-green-400 font-mono break-all">
                          {typeof window !== 'undefined' ? window.location.origin : ''}/api/webhooks/sequence/{webhookToken}
                        </code>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const url = `${window.location.origin}/api/webhooks/sequence/${webhookToken}`
                              await navigator.clipboard.writeText(url)
                              setWebhookCopied(true)
                              setTimeout(() => setWebhookCopied(false), 1500)
                            } catch { /* ignore */ }
                          }}
                          className="text-xs px-2 py-1.5 bg-un1t-black border border-un1t-gray rounded-md text-un1t-light hover:text-un1t-white"
                        >
                          {webhookCopied ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          disabled={webhookBusy}
                          onClick={async () => {
                            if (!sequenceId) return
                            if (!confirm('Rotate the webhook token? The old URL will stop working immediately.')) return
                            setWebhookBusy(true)
                            try {
                              const r = await fetch(`/api/sequences/${sequenceId}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ rotate_webhook_token: true }),
                              })
                              const j = await r.json()
                              if (j.success && j.sequence?.webhook_token) {
                                setWebhookToken(j.sequence.webhook_token)
                              }
                            } finally { setWebhookBusy(false) }
                          }}
                          className="text-xs px-2 py-1.5 bg-un1t-black border border-un1t-gray rounded-md text-un1t-light hover:text-un1t-white disabled:opacity-50"
                        >
                          Regenerate
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-un1t-light mb-1">
                        Shared secret <span className="text-un1t-mid normal-case">(optional — sender posts in <code>X-Webhook-Secret</code> header)</span>
                      </label>
                      {webhookSecret ? (
                        <div className="flex items-center gap-2">
                          <code className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-xs text-un1t-light font-mono">
                            {'•'.repeat(Math.min(32, webhookSecret.length))}
                          </code>
                          <button
                            type="button"
                            disabled={webhookBusy}
                            onClick={async () => {
                              if (!confirm('Clear the shared secret? Anyone with the URL will then be able to enrol contacts.')) return
                              setWebhookBusy(true)
                              try {
                                const r = await fetch(`/api/sequences/${sequenceId}`, {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ webhook_secret: null }),
                                })
                                const j = await r.json()
                                if (j.success) setWebhookSecret('')
                              } finally { setWebhookBusy(false) }
                            }}
                            className="text-xs px-2 py-1.5 bg-un1t-black border border-un1t-gray rounded-md text-un1t-light hover:text-un1t-white disabled:opacity-50"
                          >
                            Clear
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={webhookSecretInput}
                            onChange={(e) => setWebhookSecretInput(e.target.value)}
                            placeholder="e.g. paste a 32-char hex string from a password manager"
                            maxLength={128}
                            className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
                          />
                          <button
                            type="button"
                            disabled={webhookBusy || !webhookSecretInput.trim() || !sequenceId}
                            onClick={async () => {
                              setWebhookBusy(true)
                              try {
                                const value = webhookSecretInput.trim()
                                const r = await fetch(`/api/sequences/${sequenceId}`, {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ webhook_secret: value }),
                                })
                                const j = await r.json()
                                if (j.success) {
                                  setWebhookSecret(value)
                                  setWebhookSecretInput('')
                                }
                              } finally { setWebhookBusy(false) }
                            }}
                            className="text-xs px-2 py-1.5 bg-un1t-white text-un1t-black rounded-md hover:bg-un1t-accent disabled:opacity-50 font-medium"
                          >
                            Set secret
                          </button>
                        </div>
                      )}
                    </div>

                    <details className="text-xs text-un1t-light">
                      <summary className="cursor-pointer hover:text-un1t-white select-none">Example: enrol a contact via curl</summary>
                      <pre className="mt-2 bg-un1t-black border border-un1t-gray rounded-md p-3 text-[11px] text-green-400 font-mono overflow-x-auto">{`curl -X POST '${typeof window !== 'undefined' ? window.location.origin : 'https://crm.un1tdublin.com'}/api/webhooks/sequence/${webhookToken}' \\
  -H 'Content-Type: application/json'${webhookSecret ? ` \\\n  -H 'X-Webhook-Secret: ${webhookSecret}'` : ''} \\
  -d '{"contact_email":"member@example.com","source_ref":"glofox-event-123"}'`}</pre>
                      <p className="mt-2 text-un1t-mid">
                        Body must include <code>contact_email</code> OR <code>contact_id</code>. Optional <code>source_ref</code> appears in the audit trail.
                      </p>
                    </details>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Goal (mig 088). Optional. When met, enrolment auto-exits
              with exit_reason='goal_met' so the contact doesn't get
              the rest of the sequence after they've already converted. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
              Goal <span className="text-xs text-un1t-mid normal-case font-normal">(optional)</span>
            </h3>
            <p className="text-xs text-un1t-mid mb-3">
              Auto-exits the contact when they hit a milestone — they won&apos;t get the day-3 follow-up if they&apos;ve already converted.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                value={goalConfig?.type || ''}
                onChange={e => {
                  const t = e.target.value
                  if (!t) setGoalConfig(null)
                  else setGoalConfig({ type: t })
                }}
                className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              >
                <option value="">No goal</option>
                <option value="lead_status">Lead status reaches…</option>
                <option value="tag_added">Tag is added…</option>
                <option value="booking_made">Books an event</option>
              </select>
              {goalConfig?.type === 'lead_status' && (
                <select
                  value={goalConfig?.value || ''}
                  onChange={e => setGoalConfig({ ...goalConfig, value: e.target.value })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid sm:col-span-2"
                >
                  <option value="">(pick one)</option>
                  <option value="active_trial">active_trial</option>
                  <option value="cold">cold</option>
                  <option value="lost_member">lost_member</option>
                  <option value="member">member</option>
                  <option value="returning">returning</option>
                  <option value="competition_competitor">competition_competitor</option>
                </select>
              )}
              {goalConfig?.type === 'tag_added' && (
                <input
                  type="text"
                  value={goalConfig?.tag || ''}
                  onChange={e => setGoalConfig({ ...goalConfig, tag: e.target.value })}
                  placeholder="e.g. race_completed"
                  maxLength={60}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid sm:col-span-2"
                />
              )}
              {goalConfig?.type === 'booking_made' && (
                <p className="text-xs text-un1t-mid sm:col-span-2 self-center">
                  Triggers when this contact creates ANY booking. (Per-event-type filter coming soon.)
                </p>
              )}
            </div>
          </div>

          {/* Send window (mig 089). Optional. Push message-step
              fires forward to land within the configured local-time
              window — avoids 3am SMS pings. Skip days are
              0=Sunday … 6=Saturday. Non-message steps (apply_tag,
              update_field, internal_task, webhook) ignore this. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
              Send window <span className="text-xs text-un1t-mid normal-case font-normal">(optional, Europe/Dublin time)</span>
            </h3>
            <p className="text-xs text-un1t-mid mb-3">
              Pushes message-step fires forward to land within the chosen window. Test mode bypasses for QA.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-un1t-light mb-1">Start hour</label>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={sendWindow?.start_hour ?? ''}
                  onChange={e => {
                    const v = e.target.value === '' ? null : parseInt(e.target.value)
                    setSendWindow({ ...(sendWindow || {}), start_hour: v })
                  }}
                  placeholder="9"
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white w-20 focus:outline-none focus:border-un1t-mid"
                />
              </div>
              <div>
                <label className="block text-xs text-un1t-light mb-1">End hour (excl.)</label>
                <input
                  type="number"
                  min="0"
                  max="24"
                  value={sendWindow?.end_hour ?? ''}
                  onChange={e => {
                    const v = e.target.value === '' ? null : parseInt(e.target.value)
                    setSendWindow({ ...(sendWindow || {}), end_hour: v })
                  }}
                  placeholder="17"
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white w-20 focus:outline-none focus:border-un1t-mid"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-un1t-light mb-1">Skip days</label>
                <div className="flex gap-1 flex-wrap">
                  {[
                    { v: 0, l: 'Sun' }, { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' },
                    { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' },
                    { v: 6, l: 'Sat' },
                  ].map(d => {
                    const skipDays = Array.isArray(sendWindow?.skip_days) ? sendWindow.skip_days : []
                    const on = skipDays.includes(d.v)
                    return (
                      <button
                        key={d.v}
                        type="button"
                        onClick={() => {
                          const next = on ? skipDays.filter(x => x !== d.v) : [...skipDays, d.v]
                          setSendWindow({ ...(sendWindow || {}), skip_days: next })
                        }}
                        className={`text-[11px] px-2 py-1 rounded-md border ${
                          on
                            ? 'border-amber-500/50 bg-amber-500/10 text-amber-700'
                            : 'border-un1t-gray text-un1t-light hover:border-un1t-mid'
                        }`}
                      >
                        {d.l}
                      </button>
                    )
                  })}
                </div>
              </div>
              {sendWindow && Object.keys(sendWindow).length > 0 && (
                <button
                  type="button"
                  onClick={() => setSendWindow(null)}
                  className="text-[11px] text-un1t-light hover:text-un1t-white"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Re-enrolment cooldown (mig 090 / Tier 3C). Optional.
              Default behaviour: a contact can only be enrolled in the
              same sequence once. Setting a cooldown lets them re-enrol
              after their previous run ended N days ago. The canonical
              use case is the anniversary sequence — set 350 so it can
              fire each year without colliding with itself. */}
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
              Re-enrolment <span className="text-xs text-un1t-mid normal-case font-normal">(optional)</span>
            </h3>
            <p className="text-xs text-un1t-mid mb-3">
              Empty = each contact runs through this sequence at most once. Set days to allow the same contact to re-enter after their last run ended that long ago. Useful for anniversary or seasonal flows.
            </p>
            <div className="flex items-end gap-3">
              <div>
                <label className="block text-xs text-un1t-light mb-1">Cooldown (days)</label>
                <input
                  type="number"
                  min="0"
                  max="3650"
                  value={reEnrolCooldown}
                  onChange={e => setReEnrolCooldown(e.target.value)}
                  placeholder="e.g. 350"
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white w-28 focus:outline-none focus:border-un1t-mid"
                />
              </div>
              {reEnrolCooldown !== '' && reEnrolCooldown !== null && (
                <button
                  type="button"
                  onClick={() => setReEnrolCooldown('')}
                  className="text-[11px] text-un1t-light hover:text-un1t-white pb-2"
                >
                  Clear
                </button>
              )}
            </div>
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

          {/* Tier 3A: enrolment overview. Only renders for saved
              sequences with stats data. Five-stat strip showing the
              enrolment funnel + exit reasons. */}
          {stats && stats.enrolments?.total > 0 && (
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">
                Performance
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
                <div>
                  <div className="text-2xl font-bold tabular-nums text-un1t-white">{stats.enrolments.total}</div>
                  <div className="text-[11px] text-un1t-light">enrolled</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums text-amber-700">{stats.enrolments.active}</div>
                  <div className="text-[11px] text-un1t-light">active</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums text-emerald-700">{stats.enrolments.completed}</div>
                  <div className="text-[11px] text-un1t-light">completed</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums text-blue-700">{stats.enrolments.exited}</div>
                  <div className="text-[11px] text-un1t-light">exited</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums text-red-700">{stats.enrolments.paused}</div>
                  <div className="text-[11px] text-un1t-light">paused</div>
                </div>
              </div>
              {stats.exit_reasons && Object.keys(stats.exit_reasons).length > 0 && (
                <div className="mt-3 pt-3 border-t border-un1t-gray text-[11px] text-un1t-light flex flex-wrap gap-3">
                  <span className="text-un1t-mid">Exit reasons:</span>
                  {Object.entries(stats.exit_reasons).map(([reason, count]) => (
                    <span key={reason}>
                      <span className="font-mono">{reason}</span>: <span className="tabular-nums text-un1t-white">{count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

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
                  stats={step.id ? stats?.per_step?.[step.id] : null}
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
