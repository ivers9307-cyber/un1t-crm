'use client'

// NOTIF.3 — per-location push-notification config editor.
//
// Edits locations.notification_config (mig 170). Surface design:
//
//   - One sub-card per configurable category (currently tasks +
//     bookings — driven by CONFIGURABLE_CATEGORIES so adding a new
//     configurable category in the registry auto-shows up here).
//   - Lead times rendered as a list of chips (e.g. "1h", "1d") with
//     an X to remove + an "Add lead time" picker (presets: 15m, 30m,
//     1h, 2h, 4h, 1d, 2d, 1w; plus a "custom" input).
//   - Booking notify_roles as a checkbox row (owner / manager /
//     head_coach / staff).
//   - Per-card save (PUT only that slice). Cancel reverts to last-
//     saved.
//
// Reads + writes via /api/locations/[id]/notification-config.
// Validation mirrors the server's validateConfig so feedback is
// instant; the server is still the authority.

import { useState, useEffect } from 'react'
import { Plus, X, Bell, Loader2, Check, AlertTriangle } from 'lucide-react'
import {
  CONFIGURABLE_CATEGORIES, getNotificationCategory,
} from '@/lib/notifications-registry'
import {
  validateConfig, formatLeadTime, VALID_NOTIFY_ROLES,
  LEAD_TIME_MIN_MINUTES, LEAD_TIME_MAX_MINUTES,
} from '@/lib/notification-config'

const LEAD_PRESETS_MIN = [15, 30, 60, 120, 240, 1440, 2880, 10080]
const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head coach',
  staff: 'Staff (all on-shift)',
}

function canEdit(callerRole) {
  return callerRole === 'master' || callerRole === 'owner'
}

export default function NotificationConfigCard({ locationId, callerRole }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [effective, setEffective] = useState(null)
  // Working draft. Shape mirrors `effective` so each category's
  // sub-card can mutate its own slice without touching siblings.
  const [draft, setDraft] = useState(null)

  const editable = canEdit(callerRole)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/notification-config`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          setEffective(j.data.effective)
          setDraft(deepClone(j.data.effective))
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  if (loading) {
    return (
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 text-sm text-un1t-light inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading notification config…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300 inline-flex items-center gap-2">
        <AlertTriangle size={14} /> {error}
      </div>
    )
  }
  if (!effective || !draft) return null

  return (
    <div className="space-y-3">
      {CONFIGURABLE_CATEGORIES.map(meta => (
        <CategoryEditor
          key={meta.category}
          meta={meta}
          slice={draft.categories[meta.category]}
          savedSlice={effective.categories[meta.category]}
          editable={editable}
          locationId={locationId}
          onSaved={(newSlice) => {
            setEffective(prev => ({
              ...prev,
              categories: { ...prev.categories, [meta.category]: newSlice },
            }))
            setDraft(prev => ({
              ...prev,
              categories: { ...prev.categories, [meta.category]: deepClone(newSlice) },
            }))
          }}
          onChange={(newSlice) => {
            setDraft(prev => ({
              ...prev,
              categories: { ...prev.categories, [meta.category]: newSlice },
            }))
          }}
        />
      ))}
      {!editable && (
        <p className="text-[11px] text-un1t-mid">
          Read-only — only owners and masters can edit notification config.
        </p>
      )}
    </div>
  )
}

function CategoryEditor({ meta, slice, savedSlice, editable, locationId, onChange, onSaved }) {
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [err, setErr] = useState(null)

  const dirty = JSON.stringify(slice) !== JSON.stringify(savedSlice)
  const validation = validateConfig({
    categories: { [meta.category]: slice },
  })
  const sliceErrors = !validation.ok
    ? Object.entries(validation.errors).filter(([k]) => k.startsWith(`categories.${meta.category}`))
    : []

  async function save() {
    setErr(null); setSaving(true)
    try {
      // PUT just this slice — the server merges with whatever's
      // already stored (since validate(null) returns null = use
      // defaults, sending just one category's slice does NOT wipe
      // the other categories' stored config, because we're not
      // sending them in the body — actually we ARE wiping, the
      // server stores the full payload. So include all current
      // draft categories on save).
      //
      // Pull the full effective state from the parent and include
      // every category that has a configured slice. This is the
      // simplest correct semantics.
      const body = await buildFullPutBody(locationId, meta.category, slice)
      const res = await fetch(`/api/locations/${locationId}/notification-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setErr(j.error || `HTTP ${res.status}`)
        return
      }
      onSaved(j.data.effective.categories[meta.category])
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 1500)
    } catch (e) {
      setErr(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    onChange(deepClone(savedSlice))
    setErr(null)
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-un1t-light" />
            <h4 className="text-sm font-semibold text-un1t-white">{meta.label}</h4>
          </div>
          <p className="text-xs text-un1t-light mt-0.5">{meta.description}</p>
        </div>
        {savedAt && (
          <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1">
            <Check size={12} /> Saved
          </span>
        )}
      </div>

      {meta.configurable.leadTimes && (
        <div className="mt-3">
          <label className="block text-[11px] uppercase tracking-wider text-un1t-light mb-1.5">
            Lead times
          </label>
          <LeadTimeEditor
            values={slice.lead_times_minutes || []}
            editable={editable}
            onChange={(next) => onChange({ ...slice, lead_times_minutes: next })}
          />
        </div>
      )}

      {meta.configurable.roles && (
        <div className="mt-3">
          <label className="block text-[11px] uppercase tracking-wider text-un1t-light mb-1.5">
            Notify these roles
          </label>
          <RoleEditor
            values={slice.notify_roles || []}
            editable={editable}
            onChange={(next) => onChange({ ...slice, notify_roles: next })}
          />
        </div>
      )}

      {sliceErrors.length > 0 && (
        <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded p-2 text-xs text-red-300">
          {sliceErrors.map(([k, v]) => <div key={k}>{v}</div>)}
        </div>
      )}

      {err && (
        <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded p-2 text-xs text-red-300 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {err}
        </div>
      )}

      {editable && dirty && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || sliceErrors.length > 0}
            className="text-xs bg-un1t-white text-un1t-black font-medium px-3 py-1.5 rounded hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="text-xs text-un1t-light hover:text-un1t-white px-3 py-1.5 rounded"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function LeadTimeEditor({ values, editable, onChange }) {
  const [customMin, setCustomMin] = useState('')
  function remove(idx) {
    onChange(values.filter((_, i) => i !== idx))
  }
  function add(min) {
    const next = [...values, min].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
    onChange(next)
  }
  function addCustom() {
    const n = Number(customMin)
    if (!Number.isInteger(n) || n < LEAD_TIME_MIN_MINUTES || n > LEAD_TIME_MAX_MINUTES) return
    add(n)
    setCustomMin('')
  }
  const presets = LEAD_PRESETS_MIN.filter(p => !values.includes(p))

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 && (
          <span className="text-xs text-un1t-mid italic">No reminders configured.</span>
        )}
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1 bg-un1t-gray/40 border border-un1t-gray rounded-full px-2 py-0.5 text-xs text-un1t-white"
          >
            {formatLeadTime(v)}
            {editable && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-un1t-light hover:text-un1t-white"
                aria-label={`Remove ${formatLeadTime(v)}`}
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {editable && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {presets.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => add(p)}
              className="text-[11px] text-un1t-light hover:text-un1t-white border border-un1t-gray rounded px-2 py-0.5 inline-flex items-center gap-1"
            >
              <Plus size={10} /> {formatLeadTime(p)}
            </button>
          ))}
          <span className="text-[11px] text-un1t-mid">or custom min:</span>
          <input
            type="number"
            min={LEAD_TIME_MIN_MINUTES}
            max={LEAD_TIME_MAX_MINUTES}
            value={customMin}
            onChange={(e) => setCustomMin(e.target.value)}
            placeholder="e.g. 45"
            className="w-20 bg-un1t-black border border-un1t-gray rounded px-2 py-0.5 text-[11px] text-un1t-white"
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!customMin}
            className="text-[11px] text-un1t-light hover:text-un1t-white border border-un1t-gray rounded px-2 py-0.5 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}

function RoleEditor({ values, editable, onChange }) {
  function toggle(role) {
    onChange(values.includes(role) ? values.filter(r => r !== role) : [...values, role])
  }
  return (
    <div className="flex flex-wrap gap-3">
      {VALID_NOTIFY_ROLES.map(role => (
        <label key={role} className="inline-flex items-center gap-1.5 text-xs text-un1t-white cursor-pointer">
          <input
            type="checkbox"
            checked={values.includes(role)}
            onChange={() => toggle(role)}
            disabled={!editable}
            className="accent-un1t-white"
          />
          {ROLE_LABELS[role] || role}
        </label>
      ))}
    </div>
  )
}

// Build the PUT body that preserves all categories' current state
// (so saving Tasks doesn't wipe Bookings). The endpoint replaces
// the whole notification_config row each PUT — sending less = the
// missing categories drop to defaults next read.
async function buildFullPutBody(locationId, changedCategory, changedSlice) {
  const res = await fetch(`/api/locations/${locationId}/notification-config`)
  const j = await res.json().catch(() => ({}))
  const stored = j?.data?.stored?.categories || {}
  const next = {
    categories: {
      ...stored,
      [changedCategory]: changedSlice,
    },
  }
  return next
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)) }
