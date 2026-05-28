'use client'

import { useEffect, useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'

const FIELD_OPTIONS = [
  // CLASSIFY.1 — primary funnel-stage filter. Denormalised onto
  // contacts.pipeline_stage_slug by mig 155 (synced from deals.stage_id
  // via trigger). These are the canonical PIPELINE5 slugs.
  // pipeline_stage_slug is what operators reach for intuitively
  // ("Active Member", "Hot Conversion") — it replaced the legacy
  // "Lead Status" filter that was effectively dead (>99% defaulted to
  // 'active_trial' on import and was never reliably updated).
  { value: 'pipeline_stage_slug',   label: 'Stage',                 type: 'select',
    options: ['new_lead', 'active_trial', 'hot_conversion', 'active_member',
              'at_risk_member', 'classpass_active', 'lapsed', 'dormant',
              'dormant_classpass'] },
  // GLOFOX2.1.8 — Glofox-side raw membership status. This is what the
  // pipeline classifier reads — most operators should filter on
  // "Stage" above instead. Kept as an advanced filter for power users
  // (credit_member upsells, classpass_payg cohorts).
  { value: 'glofox_membership_status', label: 'Glofox Raw Status (advanced)', type: 'select',
    options: ['cold', 'tour', 'no_sale_tour', 'trial', 'no_sale_trial',
              'member', 'credit_member', 'classpass_payg', 'ex_member', 'lead'] },
  // CHURN-PREP.2 — current Glofox membership plan. The plan list is
  // operator-defined (not a fixed enum), so the value dropdown is
  // loaded dynamically from /api/contacts/membership-plans at mount.
  { value: 'glofox_membership_plan', label: 'Membership Plan',      type: 'plan-select' },
  // GLOFOX-PROFILE (mig 196) — wider Glofox membership profile,
  // synced nightly. Lets campaigns target billing structure and
  // member attributes alongside plan / status.
  { value: 'glofox_membership_type', label: 'Membership Type',      type: 'select',
    options: ['time', 'num_classes', 'payg'] },
  // 'locked' = a membership in payment arrears (the radar's Overdue
  // tab). Pick it to build an overdue segment for a dunning sequence.
  { value: 'glofox_membership_state', label: 'Membership State (locked = overdue)', type: 'select',
    options: ['active', 'paused', 'locked'] },
  { value: 'glofox_membership_expiry', label: 'Membership Renews/Expires', type: 'date' },
  { value: 'glofox_membership_price_cents', label: 'Membership Price (cents)', type: 'number' },
  { value: 'glofox_billing_interval', label: 'Billing Interval',    type: 'text' },
  { value: 'glofox_payment_method',  label: 'Payment Method',       type: 'text' },
  { value: 'glofox_source',          label: 'Glofox Source',        type: 'text' },
  { value: 'gender',                 label: 'Gender',               type: 'select',
    options: ['male', 'female', 'other'] },
  { value: 'glofox_roaming_enabled', label: 'Roaming Enabled',      type: 'boolean' },
  { value: 'glofox_account_active',  label: 'Glofox Account Active', type: 'boolean' },
  { value: 'emergency_contact',      label: 'Has Emergency Contact', type: 'exists' },
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
  // GLOFOX2.1.20 — Lifetime Value from invoice webhook. Powers VIP
  // segmentation, at-risk audiences, and revenue-cohort analysis.
  // Cents for precision — operator types "50000" for €500.
  { value: 'lifetime_value_cents',       label: 'Lifetime Value (cents)', type: 'number' },
  { value: 'lifetime_transaction_count', label: 'Lifetime Payments',       type: 'number' },
  { value: 'last_payment_at',            label: 'Last Payment',            type: 'date' },
  { value: 'last_invoice_at',            label: 'Last Invoice (any status)', type: 'date' },
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
  // plan-select — dynamic membership-plan dropdown. is_null / not_null
  // need no value (the value selector hides via needsValue()).
  'plan-select': [
    { value: 'eq',       label: 'is' },
    { value: 'neq',      label: 'is not' },
    { value: 'not_null', label: 'has any plan' },
    { value: 'is_null',  label: 'has no plan' },
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
  // boolean — Glofox true/false flags. eq carries a Yes/No value;
  // is_null / not_null need none (handled by needsValue()).
  boolean: [
    { value: 'eq',       label: 'is' },
    { value: 'not_null', label: 'has a value' },
    { value: 'is_null',  label: 'has no value' },
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

  // CHURN-PREP.2 — membership-plan options, loaded once the user
  // adds a "Membership Plan" row. The plan list is operator-defined,
  // so it's fetched live rather than hardcoded as an enum.
  const [planOptions, setPlanOptions] = useState(null)
  const usesPlanField = filters.some(f => f.field === 'glofox_membership_plan')
  useEffect(() => {
    if (!usesPlanField || planOptions !== null) return
    let cancelled = false
    fetch('/api/contacts/membership-plans').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setPlanOptions(j.data || [])
      else if (!cancelled) setPlanOptions([])
    }).catch(() => { if (!cancelled) setPlanOptions([]) })
    return () => { cancelled = true }
  }, [usesPlanField, planOptions])

  function updateFilter(newFilters, newLogic) {
    onChange({ filters: newFilters, logic: newLogic || logic })
  }

  function addFilter() {
    // CLASSIFY.1 — default new rows to Stage = active_member. lead_status
    // is no longer in FIELD_OPTIONS; the audience-filter allowlist
    // would reject it.
    updateFilter([
      ...filters,
      { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
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
    const defaultValue = config.type === 'select' ? (config.options?.[0] || '')
      : config.type === 'boolean' ? 'true'
      : ''
    updateRow(index, { field: newField, op: defaultOp, value: defaultValue })
  }

  return (
    <div className="space-y-4">
      {/* Logic toggle */}
      {filters.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-un1t-subtle">Match</span>
          <button
            onClick={() => updateFilter(filters, 'and')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              logic === 'and' ? 'bg-un1t-text text-un1t-bg' : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            ALL filters
          </button>
          <button
            onClick={() => updateFilter(filters, 'or')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              logic === 'or' ? 'bg-un1t-text text-un1t-bg' : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            ANY filter
          </button>
        </div>
      )}

      {/* Filter rows */}
      {filters.length === 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-center">
          <Users size={28} className="mx-auto mb-2 text-un1t-subtle" />
          <p className="text-sm text-un1t-subtle mb-1">No filters — all opted-in contacts will receive this campaign</p>
          <p className="text-xs text-un1t-muted">Add filters to narrow your audience</p>
        </div>
      )}

      <div className="space-y-2">
        {filters.map((f, index) => {
          const fieldConfig = getFieldConfig(f.field)
          const ops = OPS_BY_TYPE[fieldConfig.type] || []
          const showValue = needsValue(f.op)

          return (
            <div key={index} className="flex items-center gap-2 bg-un1t-surface border border-un1t-border rounded-lg p-3">
              {/* Connector */}
              {index > 0 && (
                <span className="text-xs text-un1t-muted font-medium w-10 text-center uppercase">
                  {logic}
                </span>
              )}
              {index === 0 && filters.length > 1 && <span className="w-10" />}

              {/* Field */}
              <select
                value={f.field}
                onChange={e => handleFieldChange(index, e.target.value)}
                className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              >
                {FIELD_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>

              {/* Operator */}
              <select
                value={f.op}
                onChange={e => updateRow(index, { op: e.target.value })}
                className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
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
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted flex-1"
                >
                  {fieldConfig.options?.map(opt => (
                    <option key={opt} value={opt}>{opt.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              ) : showValue && fieldConfig.type === 'tag-select' ? (
                <select
                  value={f.value || ''}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted flex-1"
                >
                  <option value="">— pick a tag —</option>
                  {(tagOptions || []).map(opt => (
                    <option key={opt.tag} value={opt.tag}>
                      {opt.tag} ({opt.count})
                    </option>
                  ))}
                </select>
              ) : showValue && fieldConfig.type === 'plan-select' ? (
                <select
                  value={f.value || ''}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted flex-1"
                >
                  <option value="">
                    {planOptions === null ? 'Loading plans…' : '— pick a plan —'}
                  </option>
                  {(planOptions || []).map(plan => (
                    <option key={plan} value={plan}>{plan}</option>
                  ))}
                </select>
              ) : showValue && fieldConfig.type === 'number' ? (
                <input
                  type="number"
                  value={f.value}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted w-24"
                />
              ) : showValue && fieldConfig.type === 'date' ? (
                ['days_since_gt', 'days_since_lt'].includes(f.op) ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={f.value}
                      onChange={e => updateRow(index, { value: e.target.value })}
                      placeholder="30"
                      className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted w-20"
                    />
                    <span className="text-xs text-un1t-muted">days</span>
                  </div>
                ) : (
                  <input
                    type="date"
                    value={f.value}
                    onChange={e => updateRow(index, { value: e.target.value })}
                    className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                  />
                )
              ) : showValue && fieldConfig.type === 'boolean' ? (
                <select
                  value={f.value === true || f.value === 'true' ? 'true' : 'false'}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted flex-1"
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : showValue ? (
                <input
                  type="text"
                  value={f.value}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  placeholder="Value..."
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted flex-1"
                />
              ) : null}

              {/* Remove */}
              <button
                onClick={() => removeFilter(index)}
                className="p-1.5 text-un1t-muted hover:text-red-400 transition-colors rounded"
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
          className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text transition-colors"
        >
          <Plus size={14} />
          Add filter
        </button>

        {audienceCount !== null && (
          <span className="text-sm text-un1t-subtle">
            <Users size={14} className="inline mr-1.5" />
            <strong className="text-un1t-text">{audienceCount}</strong> contacts match
          </span>
        )}
      </div>
    </div>
  )
}
