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
// Access mirrors the PUT route: master or owner at this location.
// 'master' has no tab — the resolver short-circuits master, so a
// master template could never take effect.

import { useEffect, useMemo, useState } from 'react'
import { Check, AlertCircle, RotateCcw } from 'lucide-react'
import {
  WEB_PERMISSIONS,
  MOBILE_PERMISSIONS,
  hydratePermissions,
} from '@shared/permissions'

const ROLE_TABS = [
  { key: 'owner', label: 'Owner' },
  { key: 'manager', label: 'Manager' },
  { key: 'head_coach', label: 'Head coach' },
  { key: 'staff', label: 'Staff' },
  { key: 'reception', label: 'Reception' },
]

function Toggle({ on, changed, onToggle, busy, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-un1t-text flex items-center gap-1.5">
          {label}
          {changed && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
              title="Changed from the built-in default for this role"
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
  // { [role]: full effective blob } — what the toggles render/edit.
  const [blobs, setBlobs] = useState(null)
  const [dirtyRoles, setDirtyRoles] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/role-permissions`)
        const json = await res.json()
        if (!json.success) throw new Error(json.error || 'Failed to load role permissions')
        if (cancelled) return
        const next = {}
        for (const t of ROLE_TABS) next[t.key] = json.data[t.key]?.effective || hydratePermissions(null, t.key)
        setBlobs(next)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
  }, [locationId])

  // Code defaults for the active role — used for the "changed" dots
  // and the reset affordance.
  const codeDefaults = useMemo(() => hydratePermissions(null, activeRole), [activeRole])
  const blob = blobs?.[activeRole]

  const webItems = WEB_PERMISSIONS
  const mobileItems = MOBILE_PERMISSIONS.filter((p) => !p.isNotify)
  const notifyItems = MOBILE_PERMISSIONS.filter((p) => p.isNotify)

  function setKey(key, mobile, value) {
    setBlobs((prev) => {
      const cur = prev[activeRole]
      const next = mobile
        ? { ...cur, mobile: { ...cur.mobile, [key]: value } }
        : { ...cur, [key]: value }
      return { ...prev, [activeRole]: next }
    })
    setDirtyRoles((d) => ({ ...d, [activeRole]: true }))
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/role-permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: activeRole, permissions: blobs[activeRole] }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Save failed')
      setBlobs((prev) => ({ ...prev, [activeRole]: json.data.effective }))
      setDirtyRoles((d) => ({ ...d, [activeRole]: false }))
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function resetToDefaults() {
    setBlobs((prev) => ({ ...prev, [activeRole]: hydratePermissions(null, activeRole) }))
    setDirtyRoles((d) => ({ ...d, [activeRole]: true }))
    setSavedAt(null)
  }

  if (error && !blob) {
    return <div className="text-sm text-red-700 flex items-center gap-2"><AlertCircle size={14} /> {error}</div>
  }
  if (!blob) {
    return <div className="text-sm text-un1t-subtle">Loading role permissions…</div>
  }

  const changedCount =
    webItems.filter((p) => blob[p.key] !== codeDefaults[p.key]).length +
    MOBILE_PERMISSIONS.filter((p) => blob.mobile?.[p.key] !== codeDefaults.mobile?.[p.key]).length

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {ROLE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveRole(t.key)}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              activeRole === t.key
                ? 'bg-un1t-text text-un1t-black'
                : 'text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {t.label}
            {dirtyRoles[t.key] ? ' •' : ''}
          </button>
        ))}
      </div>

      <p className="text-[12px] text-un1t-subtle mb-4">
        These are the defaults every <span className="font-medium">{ROLE_TABS.find(t => t.key === activeRole)?.label.toLowerCase()}</span> at
        this studio inherits. Per-user overrides in Staff Management still win. Keys left at the
        built-in default (no amber dot) keep following future product updates automatically.
        {changedCount > 0 && <> {changedCount} key{changedCount === 1 ? '' : 's'} changed from the built-in default.</>}
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
                changed={blob[p.key] !== codeDefaults[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, false, !(blob[p.key] === true))}
              />
            ))}
          </div>
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
                changed={blob.mobile?.[p.key] !== codeDefaults.mobile?.[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, true, !(blob.mobile?.[p.key] === true))}
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-un1t-subtle mb-1">Notification defaults</h3>
          <p className="text-[11px] text-un1t-subtle mb-1">
            Default push-notification preferences for new and non-customised users of this role.
            Each person can still be tuned individually in Staff Management.
          </p>
          <div className="divide-y divide-un1t-border/60">
            {notifyItems.map((p) => (
              <Toggle
                key={p.key}
                label={p.label}
                hint={p.hint}
                on={blob.mobile?.[p.key] === true}
                changed={blob.mobile?.[p.key] !== codeDefaults.mobile?.[p.key]}
                busy={saving}
                onToggle={() => setKey(p.key, true, !(blob.mobile?.[p.key] === true))}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center gap-3 mt-6 sticky bottom-0 bg-un1t-black/95 py-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirtyRoles[activeRole]}
          className="px-4 py-2 rounded-lg bg-un1t-text text-un1t-black text-sm font-medium disabled:opacity-40"
        >
          {saving ? 'Saving…' : `Save ${ROLE_TABS.find(t => t.key === activeRole)?.label} permissions`}
        </button>
        <button
          type="button"
          onClick={resetToDefaults}
          disabled={saving}
          className="px-3 py-2 rounded-lg text-sm text-un1t-subtle hover:text-un1t-text flex items-center gap-1.5 disabled:opacity-40"
        >
          <RotateCcw size={13} /> Reset to built-in defaults
        </button>
        {savedAt && !dirtyRoles[activeRole] && (
          <span className="text-[12px] text-green-700 flex items-center gap-1"><Check size={13} /> Saved</span>
        )}
        {error && <span className="text-[12px] text-red-700 flex items-center gap-1"><AlertCircle size={13} /> {error}</span>}
      </div>
    </div>
  )
}
