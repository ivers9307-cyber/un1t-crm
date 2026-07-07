'use client'

// PERM-AUDIT.2 — operator-editable role permission templates.
//
// Edits what each ROLE grants at this location (mig 364). The
// resolver reads the template between the per-user override and the
// code default, so:
//   • flipping a toggle here changes every user of that role at this
//     location who has no explicit per-user override for that key;
//   • per-user overrides in StaffForm still win;
//   • a key left at its default keeps inheriting future code-default
//     changes (the server stores only the sparse diff).
//
// RECEPTION.2 (mig 367): the Staff role additionally splits by
// employment type — an "All staff" base template plus FTE /
// Contractor / Casual variants that layer on top of it for users
// whose profiles.employment_type matches. Variant toggles show the
// full effective state (code defaults + base + variant) and the
// amber dot marks keys changed from what the variant inherits.
//
// Access mirrors the PUT route: master or owner at this location.
// 'master' has no tab — the resolver short-circuits master, so a
// master template could never take effect.

import { useCallback, useEffect, useState } from 'react'
import { Check, AlertCircle, RotateCcw } from 'lucide-react'
import {
  WEB_PERMISSIONS,
  MOBILE_PERMISSIONS,
  hydratePermissions,
} from '@shared/permissions'
import AcDeviceAllowlistPicker from './AcDeviceAllowlistPicker'

const ROLE_TABS = [
  { key: 'owner', label: 'Owner' },
  { key: 'manager', label: 'Manager' },
  { key: 'head_coach', label: 'Head coach' },
  { key: 'staff', label: 'Staff' },
  { key: 'reception', label: 'Reception' },
]

// Employment-type variants (RECEPTION.2). Shown for the staff role
// only — the other roles are single-template. 'all' is the base.
const SEGMENTS = [
  { key: 'all', label: 'All staff' },
  { key: 'fte', label: 'FTE' },
  { key: 'contractor', label: 'Contractor' },
  { key: 'casual', label: 'Casual' },
]
const SEGMENTED_ROLES = ['staff']

function Toggle({ on, changed, onToggle, busy, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-un1t-text flex items-center gap-1.5">
          {label}
          {changed && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
              title="Changed from what this role inherits by default"
            />
          )}
        </div>
        {hint && <div className="text-[11px] text-un1t-subtle mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={`shrink-0 w-10 h-5 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-green-500' : 'bg-un1t-border'}`}
        aria-pressed={on}
      >
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export default function RolePermissions({ locationId }) {
  const [activeRole, setActiveRole] = useState('staff')
  const [activeSegment, setActiveSegment] = useState('all')
  // Server truth from GET: { [role]: { template, effective, variants } }
  const [data, setData] = useState(null)
  // Local edits, keyed `${role}|${segment}` → full effective blob.
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/locations/${locationId}/role-permissions`)
    const json = await res.json()
    if (!json.success) throw new Error(json.error || 'Failed to load role permissions')
    setData(json.data)
  }, [locationId])

  useEffect(() => {
    let cancelled = false
    load().catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [load])

  // Non-segmented roles always edit the 'all' slice.
  const segment = SEGMENTED_ROLES.includes(activeRole) ? activeSegment : 'all'
  const editKey = `${activeRole}|${segment}`

  // What this slice inherits BEFORE its own stored diffs — the
  // baseline for the amber "changed" dots and the reset affordance.
  // 'all' inherits the code defaults; a variant inherits code
  // defaults + the role's saved 'all' template.
  const baseline = segment === 'all'
    ? hydratePermissions(null, activeRole)
    : hydratePermissions(null, activeRole, data?.[activeRole]?.template || null)

  const serverBlob = segment === 'all'
    ? data?.[activeRole]?.effective
    : data?.[activeRole]?.variants?.[segment]?.effective
  const blob = edits[editKey] || serverBlob

  const [acEdits, setAcEdits] = useState({})
  const serverAc = segment === 'all'
    ? (data?.[activeRole]?.ac_device_ids ?? null)
    : (data?.[activeRole]?.variants?.[segment]?.ac_device_ids ?? null)
  const currentAc = (editKey in acEdits) ? acEdits[editKey] : serverAc
  function setAc(next) {
    setAcEdits((prev) => ({ ...prev, [editKey]: next }))
    setSavedAt(null)
  }

  // APPROVALS-PERCAT.1 — approvals_inbox is location-gate-only (edited in
  // Location Features, not here); the six per-category grants render in
  // their own "Approvals" group below.
  const webItems = WEB_PERMISSIONS.filter((p) => !p.locationGateOnly && p.group !== 'approvals')
  const approvalItems = WEB_PERMISSIONS.filter((p) => p.group === 'approvals')
  const mobileItems = MOBILE_PERMISSIONS.filter((p) => !p.isNotify)
  const notifyItems = MOBILE_PERMISSIONS.filter((p) => p.isNotify)

  function setKey(key, mobile, value) {
    const cur = blob
    const next = mobile
      ? { ...cur, mobile: { ...cur.mobile, [key]: value } }
      : { ...cur, [key]: value }
    setEdits((prev) => ({ ...prev, [editKey]: next }))
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/role-permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: activeRole, employment_type: segment, permissions: blob, ac_device_ids: currentAc }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Save failed')
      // Re-fetch the whole map: saving the 'all' base shifts what
      // every variant inherits, so a local patch isn't enough.
      await load()
      setEdits((prev) => {
        const next = { ...prev }
        delete next[editKey]
        return next
      })
      setAcEdits((prev) => {
        const next = { ...prev }
        delete next[editKey]
        return next
      })
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function resetToBaseline() {
    setEdits((prev) => ({ ...prev, [editKey]: baseline }))
    setSavedAt(null)
  }

  if (error && !blob) {
    return <div className="text-sm text-red-700 flex items-center gap-2"><AlertCircle size={14} /> {error}</div>
  }
  if (!blob) {
    return <div className="text-sm text-un1t-subtle">Loading role permissions…</div>
  }

  const dirty = !!edits[editKey] || (editKey in acEdits)
  const changedCount =
    webItems.filter((p) => blob[p.key] !== baseline[p.key]).length +
    approvalItems.filter((p) => blob[p.key] !== baseline[p.key]).length +
    MOBILE_PERMISSIONS.filter((p) => blob.mobile?.[p.key] !== baseline.mobile?.[p.key]).length

  const roleLabel = ROLE_TABS.find((t) => t.key === activeRole)?.label
  const segmentLabel = SEGMENTS.find((s) => s.key === segment)?.label

  return (
    <div>
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {ROLE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setActiveRole(t.key); setSavedAt(null) }}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              activeRole === t.key
                ? 'bg-un1t-text text-un1t-bg'
                : 'text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {t.label}
            {Object.keys(edits).some((k) => k.startsWith(`${t.key}|`)) ? ' •' : ''}
          </button>
        ))}
      </div>

      {SEGMENTED_ROLES.includes(activeRole) && (
        <div className="flex items-center gap-1 mb-3 flex-wrap">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => { setActiveSegment(s.key); setSavedAt(null) }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                activeSegment === s.key
                  ? 'border-un1t-text text-un1t-text bg-un1t-surface'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <p className="text-[12px] text-un1t-subtle mb-4">
        {segment === 'all' ? (
          <>These are the defaults every <span className="font-medium">{roleLabel?.toLowerCase()}</span> at
          this studio inherits. Per-user overrides in Staff Management still win.</>
        ) : (
          <>These apply to <span className="font-medium">{segmentLabel?.toLowerCase()}</span> staff only, layered on
          top of the All-staff defaults. Per-user overrides in Staff Management still win.</>
        )}{' '}
        Keys left at the inherited value (no amber dot) keep following future updates automatically.
        {changedCount > 0 && <> {changedCount} key{changedCount === 1 ? '' : 's'} changed here.</>}
      </p>

      <div className="space-y-6">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Web features</h3>
          <div className="divide-y divide-un1t-border/60">
            {webItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob[p.key] === true}
                changed={blob[p.key] !== baseline[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, false, !(blob[p.key] === true))}
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Approvals</h3>
          <div className="divide-y divide-un1t-border/60">
            {approvalItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob[p.key] === true}
                changed={blob[p.key] !== baseline[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, false, !(blob[p.key] === true))}
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">AC devices</h3>
          <p className="text-[11px] text-un1t-subtle mb-2">
            Default AC units this role controls at this location. Takes effect only when
            Studio Management is on for the role. Individual profiles can override.
          </p>
          <AcDeviceAllowlistPicker
            locationId={locationId}
            locationName=""
            value={currentAc}
            inheritLabel="Inherit code default"
            onChange={setAc}
          />
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Mobile features</h3>
          <div className="divide-y divide-un1t-border/60">
            {mobileItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob.mobile?.[p.key] === true}
                changed={blob.mobile?.[p.key] !== baseline.mobile?.[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, true, !(blob.mobile?.[p.key] === true))}
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Notification defaults</h3>
          <p className="text-[11px] text-un1t-subtle mb-1">
            Default push-notification preferences for new and non-customised users.
            Each person can still be tuned individually in Staff Management.
          </p>
          <div className="divide-y divide-un1t-border/60">
            {notifyItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob.mobile?.[p.key] === true}
                changed={blob.mobile?.[p.key] !== baseline.mobile?.[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, true, !(blob.mobile?.[p.key] === true))}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center gap-3 mt-6 sticky bottom-0 bg-un1t-bg/95 py-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="px-4 py-2 rounded-lg bg-un1t-text text-un1t-bg text-sm font-medium hover:bg-un1t-accent disabled:opacity-40"
        >
          {saving ? 'Saving…' : `Save ${segment === 'all' ? roleLabel : `${segmentLabel} staff`} permissions`}
        </button>
        <button
          type="button"
          onClick={resetToBaseline}
          disabled={saving}
          className="px-3 py-2 rounded-lg text-sm text-un1t-subtle hover:text-un1t-text flex items-center gap-1.5 disabled:opacity-40"
        >
          <RotateCcw size={13} /> Reset to inherited defaults
        </button>
        {savedAt && !dirty && (
          <span className="text-[12px] text-green-700 flex items-center gap-1"><Check size={13} /> Saved</span>
        )}
        {error && <span className="text-[12px] text-red-700 flex items-center gap-1"><AlertCircle size={13} /> {error}</span>}
      </div>
    </div>
  )
}
