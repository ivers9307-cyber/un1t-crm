'use client'

// NOTIF.7 + NOTIF.10 — per-user lead-time override editor for the
// StaffForm mobile-permissions section.
//
// Stored shape under permissions.mobile.lead_time_overrides:
//
//   { tasks:    { lead_times_minutes: [30, 60] },
//     bookings: { lead_times_minutes: [15] } }
//
// Both categories are user-overridable. Empty / null on either =
// "use the location's default for that category". The cron's
// getEffectiveLeadTimesForUser does the resolution chain
// (user → location → built-in default).

import { useState } from 'react'
import { Plus, X, Bell } from 'lucide-react'
import { formatLeadTime, LEAD_TIME_MIN_MINUTES, LEAD_TIME_MAX_MINUTES } from '@/lib/notification-config'

const LEAD_PRESETS_MIN = [15, 30, 60, 120, 240, 1440, 2880]

const CATEGORY_LABELS = {
  tasks:    { title: 'Task reminder lead times', subtitle: 'When this user gets pinged before their assigned tasks are due.' },
  bookings: { title: 'Booking reminder lead times', subtitle: 'When this user gets pinged before bookings at this location. Per-user override beats the location default — useful when one operator wants earlier nudges than the team norm.' },
}

export default function LeadTimeOverrideRow({ overrides, onChange, category = 'tasks' }) {
  const labels = CATEGORY_LABELS[category] || CATEGORY_LABELS.tasks
  const currentValues = overrides?.[category]?.lead_times_minutes
  const isOverridden = Array.isArray(currentValues) && currentValues.length > 0
  const [expanded, setExpanded] = useState(isOverridden)
  const [customMin, setCustomMin] = useState('')

  function setValues(next) {
    // null / empty = remove the override for this category
    if (!next || next.length === 0) {
      const { [category]: _drop, ...rest } = overrides || {}
      onChange(rest)
      return
    }
    onChange({ ...(overrides || {}), [category]: { lead_times_minutes: next } })
  }

  function add(min) {
    const current = currentValues || []
    const next = [...current, min].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
    setValues(next)
  }
  function remove(idx) {
    const current = currentValues || []
    setValues(current.filter((_, i) => i !== idx))
  }
  function addCustom() {
    const n = Number(customMin)
    if (!Number.isInteger(n) || n < LEAD_TIME_MIN_MINUTES || n > LEAD_TIME_MAX_MINUTES) return
    add(n)
    setCustomMin('')
  }
  function clearOverride() {
    setValues(null)
  }

  if (!expanded) {
    return (
      <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3 mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-un1t-subtle" />
          <div>
            <div className="text-xs font-semibold text-un1t-text">{labels.title}</div>
            <div className="text-[11px] text-un1t-subtle">
              Using location default (1h + 24h before due).
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-blue-400 hover:text-blue-300"
        >
          Customize for this user
        </button>
      </div>
    )
  }

  const presets = LEAD_PRESETS_MIN.filter(p => !(currentValues || []).includes(p))

  return (
    <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3 mb-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-un1t-subtle" />
          <div>
            <div className="text-xs font-semibold text-un1t-text">
              {labels.title} — user override
            </div>
            <div className="text-[11px] text-un1t-subtle">
              {labels.subtitle}
            </div>
          </div>
        </div>
        {isOverridden && (
          <button
            type="button"
            onClick={() => { clearOverride(); setExpanded(false) }}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
          >
            Reset to default
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2 min-h-6">
        {!isOverridden && (
          <span className="text-[11px] text-un1t-muted italic">
            No override set — using location default (1h + 24h).
          </span>
        )}
        {(currentValues || []).map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1 bg-un1t-border/40 border border-un1t-border rounded-full px-2 py-0.5 text-xs text-un1t-text"
          >
            {formatLeadTime(v)}
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-un1t-subtle hover:text-un1t-text"
              aria-label={`Remove ${formatLeadTime(v)}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {presets.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => add(p)}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded px-2 py-0.5 inline-flex items-center gap-1"
          >
            <Plus size={10} /> {formatLeadTime(p)}
          </button>
        ))}
        <span className="text-[11px] text-un1t-muted">or custom min:</span>
        <input
          type="number"
          min={LEAD_TIME_MIN_MINUTES}
          max={LEAD_TIME_MAX_MINUTES}
          value={customMin}
          onChange={(e) => setCustomMin(e.target.value)}
          placeholder="45"
          className="w-16 bg-un1t-bg border border-un1t-border rounded px-2 py-0.5 text-[11px] text-un1t-text"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!customMin}
          className="text-[11px] text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded px-2 py-0.5 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  )
}
