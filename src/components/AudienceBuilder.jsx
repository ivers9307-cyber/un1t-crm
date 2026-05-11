'use client'

import { useEffect, useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'

const FIELD_OPTIONS = [
  { value: 'lead_status',           label: 'Lead Status',           type: 'select',
    options: ['active_trial', 'cold', 'lost_member', 'member', 'returning', 'competition_competitor'] },
  // GLOFOX2.1.8 — Glofox-side Client Status (synced from Glofox via
  // /api/glofox/sync-member). Distinct from lead_status (which is
  // local-CRM). Three of the values are synthesised from deeper
  // Glofox payload signals (credit_member, classpass_payg, ex_member)
  // — see src/lib/glofox-sync.js for the detection rules.
  { value: 'glofox_membership_status', label: 'Glofox Status',      type: 'select',
    options: ['cold', 'tour', 'no_sale_tour', 'trial', 'no_sale_trial',
              'member', 'credit_member', 'classpass_payg', 'ex_member', 'lead'] },
  { value: 'email_status',          label: 'Email Status',          type: 'select',
    options: ['active', 'bounced', 'complained', 'unsubscribed'] },
  { value: 'lead_source',           label: 'Lead Source',           type: 'select',
    options: ['booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'classpass', 'other'] },
  { value: 'label',                 label: 'Label',                 type: 'text' },
  { value: 'tags',                  label: 'Free-text tag',         type: 'text' },
  // Phase 3 (mig 085): machine-derived retargeting tags. Resolved
  // server-side via contact_tags. The select options are loaded
  // dynamically from /api/segments at mount time.
  { value: 'tag',                   label: 'Segment tag',           type: 'tag-select' },
  { value: 'total_emails_sent',     label: 'Emails Sent',           type: 'number' },
  { value: 'total_emails_opened',   label: 'Emails Opened',         type: 'number' },
  { value: 'trial_credits_remaining', label: 'Trial Credits Left',  type: 'number' },
  { value: 'last_emailed_at',       label: 'Last Emailed',          type: 'date' },
  { value: 'created_at',            label: 'Contact Created',       type: 'date' },
  { value: 'lead_created_at',       label: 'Lead Created',          type: 'date' },
  // GLOFOX2.1.13 — Glofox-side tenure date (joined_at preferred,
  // falls back to created). Powers "Members > 6 months" anniversary
  // campaigns + cohort analysis.
  { value: 'joined_at',             label: 'Joined (Glofox)',       type: 'date' },
  // GLOFOX2.1.14 — booking-engagement aggregates from Glofox sync.
  // Powers re-engagement audiences ("haven't attended in 14 days"),
  // welcome sequences ("first attendance"), and high-engagement
  // segmentation ("attended >8 classes this month").
  { value: 'last_attended_at',      label: 'Last Attended (Glofox)', type: 'date' },
  { value: 'last_booked_at',        label: 'Last Booked (Glofox)',   type: 'date' },
  { value: 'total_attended_30d',    label: 'Attended (30d)',         type: 'number' },
  { value: 'total_bookings_30d',    label: 'Bookings (30d)',         type: 'number' },
  { value: 'total_noshow_30d',      label: 'No-shows (30d)',         type: 'number' },
  { value: 'glofox_member_id',      label: 'Has Glofox ID',         type: 'exists' },
  { value: 'phone',                 label: 'Has Phone',             type: 'exists' },
]

const OPS_BY_TYPE = {
  select:  [
    { value: 'eq',  label: 'is' },
    { value: 'neq', label: 'is not' },
  ],
  // tag-select uses the same eq/neq semantics as select but pulls
  // its options dynamically from /api/segments.
  'tag-select': [
    { value: 'eq',  label: 'has tag' },
    { value: 'neq', label: 'does not have tag' },
  ],
  text:    [
    { value: 'eq',           label: 'equals' },
    { value: 'neq',          label: 'does not equal' },
    { value: 'contains',     label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
  ],
  number:  [
    { value: 'eq',  label: 'equals' },
    { value: 'gt',  label: 'greater than' },
    { value: 'lt',  label: 'less than' },
    { value: 'gte', label: 'at least' },
    { value: 'lte', label: 'at most' },
  ],
  date:    [
    { value: 'gt',       label: 'after' },
    { value: 'lt',       label: 'before' },
    { value: 'is_null',  label: 'has no value' },
    { value: 'not_null', label: 'has a value' },
    { value: 'days_since_gt', label: 'more than X days ago' },
    { value: 'days_since_lt', label: 'less than X days ago' },
  ],
  exists:  [
    { value: 'not_null', label: 'exists' },
    { value: 'is_null',  label: 'does not exist' },
  ],
}

function getFieldConfig(fieldValue) {
  return FIELD_OPTIONS.find(f => f.value === fieldValue) || FIELD_OPTIONS[0]
}

function needsValue(op) {
  return !['is_null', 'not_null'].includes(op)
}

export default function AudienceBuilder({ filter, onChange, audienceCount }) {
  const filters = filter?.filters || []
  const logic = filter?.logic || 'and'

  // Tag options loaded once at mount from /api/segments (Phase 3,
  // mig 085). Only fetched if the user actually opens a tag-select
  // row — keeps the page free for callers that don't use tags.
  const [tagOptions, setTagOptions] = useState(null)
  const usesTagField = filters.some(f => f.field === 'tag')
  useEffect(() => {
    if (!usesTagField || tagOptions !== null) return
    let cancelled = false
    fetch('/api/segments').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setTagOptions(j.data || [])
      else if (!cancelled) setTagOptions([])
    }).catch(() => { if (!cancelled) setTagOptions([]) })
    return () => { cancelled = true }
  }, [usesTagField, tagOptions])

  function updateFilter(newFilters, newLogic) {
    onChange({ filters: newFilters, logic: newLogic || logic })
  }

  function addFilter() {
    updateFilter([
      ...filters,
      { field: 'lead_status', op: 'eq', value: 'member' },
    ])
  }

  function removeFilter(index) {
    updateFilter(filters.filter((_, i) => i !== index))
  }

  function updateRow(index, updates) {
    const updated = filters.map((f, i) => (i === index ? { ...f, ...updates } : f))
    updateFilter(updated)
  }

  function handleFieldChange(index, newField) {
    const config = getFieldConfig(newField)
    const ops = OPS_BY_TYPE[config.type] || []
    const defaultOp = ops[0]?.value || 'eq'
    const defaultValue = config.type === 'select' ? (config.options?.[0] || '') : ''
    updateRow(index, { field: newField, op: defaultOp, value: defaultValue })
  }

  return (
    <div className="space-y-4">
      {/* Logic toggle */}
      {filters.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-un1t-light">Match</span>
          <button
            onClick={() => updateFilter(filters, 'and')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              logic === 'and' ? 'bg-un1t-white text-un1t-black' : 'border border-un1t-gray text-un1t-light hover:text-un1t-white'
            }`}
          >
            ALL filters
          </button>
          <button
            onClick={() => updateFilter(filters, 'or')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              logic === 'or' ? 'bg-un1t-white text-un1t-black' : 'border border-un1t-gray text-un1t-light hover:text-un1t-white'
            }`}
          >
            ANY filter
          </button>
        </div>
      )}

      {/* Filter rows */}
      {filters.length === 0 && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 text-center">
          <Users size={28} className="mx-auto mb-2 text-un1t-light" />
          <p className="text-sm text-un1t-light mb-1">No filters — all opted-in contacts will receive this campaign</p>
          <p className="text-xs text-un1t-mid">Add filters to narrow your audience</p>
        </div>
      )}

      <div className="space-y-2">
        {filters.map((f, index) => {
          const fieldConfig = getFieldConfig(f.field)
          const ops = OPS_BY_TYPE[fieldConfig.type] || []
          const showValue = needsValue(f.op)

          return (
            <div key={index} className="flex items-center gap-2 bg-un1t-dark border border-un1t-gray rounded-lg p-3">
              {/* Connector */}
              {index > 0 && (
                <span className="text-xs text-un1t-mid font-medium w-10 text-center uppercase">
                  {logic}
                </span>
              )}
              {index === 0 && filters.length > 1 && <span className="w-10" />}

              {/* Field */}
              <select
                value={f.field}
                onChange={e => handleFieldChange(index, e.target.value)}
                className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              >
                {FIELD_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>

              {/* Operator */}
              <select
                value={f.op}
                onChange={e => updateRow(index, { op: e.target.value })}
                className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              >
                {ops.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>

              {/* Value */}
              {showValue && fieldConfig.type === 'select' ? (
                <select
                  value={f.value}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid flex-1"
                >
                  {fieldConfig.options?.map(opt => (
                    <option key={opt} value={opt}>{opt.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              ) : showValue && fieldConfig.type === 'tag-select' ? (
                <select
                  value={f.value || ''}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid flex-1"
                >
                  <option value="">— pick a tag —</option>
                  {(tagOptions || []).map(opt => (
                    <option key={opt.tag} value={opt.tag}>
                      {opt.tag} ({opt.count})
                    </option>
                  ))}
                </select>
              ) : showValue && fieldConfig.type === 'number' ? (
                <input
                  type="number"
                  value={f.value}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid w-24"
                />
              ) : showValue && fieldConfig.type === 'date' ? (
                ['days_since_gt', 'days_since_lt'].includes(f.op) ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={f.value}
                      onChange={e => updateRow(index, { value: e.target.value })}
                      placeholder="30"
                      className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid w-20"
                    />
                    <span className="text-xs text-un1t-mid">days</span>
                  </div>
                ) : (
                  <input
                    type="date"
                    value={f.value}
                    onChange={e => updateRow(index, { value: e.target.value })}
                    className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                  />
                )
              ) : showValue ? (
                <input
                  type="text"
                  value={f.value}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  placeholder="Value..."
                  className="bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid flex-1"
                />
              ) : null}

              {/* Remove */}
              <button
                onClick={() => removeFilter(index)}
                className="p-1.5 text-un1t-mid hover:text-red-400 transition-colors rounded"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Add filter + count */}
      <div className="flex items-center justify-between">
        <button
          onClick={addFilter}
          className="flex items-center gap-1.5 text-xs text-un1t-light hover:text-un1t-white transition-colors"
        >
          <Plus size={14} />
          Add filter
        </button>

        {audienceCount !== null && (
          <span className="text-sm text-un1t-light">
            <Users size={14} className="inline mr-1.5" />
            <strong className="text-un1t-white">{audienceCount}</strong> contacts match
          </span>
        )}
      </div>
    </div>
  )
}
