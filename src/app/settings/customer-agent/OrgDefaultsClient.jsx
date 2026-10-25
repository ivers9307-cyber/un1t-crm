'use client'

import { useState, useEffect } from 'react'
import { Button, Field } from '@/components/ui'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
// MIAORG.1 Task 4 — the same override bookkeeping as the studio editor (which
// paths a layer sets), zod-free.
import { initialOverridden, withOverride, withoutOverride, isOverridden, valueAt, isHalfQuietWindow } from '@/lib/agent/settings-overrides'
import {
  describeInheritance, newlyAppliedFields, describeNewlyApplied, copyablePaths, nonBlankSetPaths,
} from '@/lib/agent/settings-org'
import { buildOrgSavePayload } from './save-payload'
import { ORG_FIELD_GROUPS, ORG_FIELDS } from './org-fields'

// MIAORG.1 Task 4 — "Organisation defaults (all studios)": Mia's settings
// set once for the organisation (org_settings.customer_agent). Every studio
// uses them unless it sets its own (the studio editor below). Masters and
// organisation admins only: the server page decides (resolveAdminOrgId) and
// passes just the organisation's id and name; everything else is fetched
// from /api/settings/customer-agent/org, which applies the same rule.
//
// T4-A — null means "inherit", so a studio cannot store "none" once an org
// value exists. Each field therefore names the studios that will use the org
// value and those that set their own, and the Save shows, before it runs,
// which studios START using a value the organisation did not set before.
// The copy action previews the same before it writes.

const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
const ORG_API = '/api/settings/customer-agent/org'

export default function OrgDefaultsClient({ organizationId, organizationName = null, onSaved } = {}) {
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  // The org layer over the defaults, as edited.
  const [values, setValues] = useState(null)
  // The paths the organisation sets now, and when the editor loaded (T4-A).
  const [set, setSet] = useState([])
  const [loadedSet, setLoadedSet] = useState([])
  const [defaults, setDefaults] = useState({})
  const [studios, setStudios] = useState([])
  const [orgName, setOrgName] = useState(organizationName)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)
  const [copyFrom, setCopyFrom] = useState('')
  const [copyPreview, setCopyPreview] = useState(false)

  function apply(data) {
    setValues(data.settings || {})
    const paths = initialOverridden(data.raw)
    setSet(paths); setLoadedSet(paths)
    setDefaults(data.defaults || {})
    if (Array.isArray(data.studios)) setStudios(data.studios)
    if (data.organization?.name) setOrgName(data.organization.name)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const j = await fetch(`${ORG_API}?organization_id=${encodeURIComponent(organizationId)}`).then(r => r.json())
        if (cancelled) return
        if (j?.success && j.data) { apply(j.data); setLoadFailed(false) } else setLoadFailed(true)
      } catch {
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [organizationId])

  // Try again: the note stays up until a good read replaces it.
  async function reload() {
    try {
      const j = await fetch(`${ORG_API}?organization_id=${encodeURIComponent(organizationId)}`).then(r => r.json())
      if (j?.success && j.data) { apply(j.data); setLoadFailed(false) } else setLoadFailed(true)
    } catch { setLoadFailed(true) } finally { setLoading(false) }
  }

  function setPath(path, value) {
    setValues(v => {
      const dot = path.indexOf('.')
      if (dot < 0) return { ...v, [path]: value }
      const key = path.slice(0, dot)
      return { ...v, [key]: { ...(v[key] || {}), [path.slice(dot + 1)]: value } }
    })
  }
  function edit(field, path, value) {
    setPath(path, value)
    setSet(s => withOverride(s, ...field.paths))
  }
  // Quiet hours are a pair (no zone: each studio's own clock, T4-B).
  function editQuiet(end, value) {
    setValues(v => ({ ...v, quiet_hours: { ...(v.quiet_hours || {}), [end]: value, tz: null } }))
    setSet(s => withOverride(s, 'quiet_hours.start', 'quiet_hours.end'))
  }
  // "Use default": the organisation stops setting it; the field shows the
  // built-in default again.
  function clear(field) {
    setSet(s => withoutOverride(s, ...field.paths))
    setValues(v => {
      const next = { ...v }
      for (const p of field.paths) {
        const dot = p.indexOf('.')
        if (dot < 0) {
          const d = defaults[p]
          next[p] = d && typeof d === 'object' ? { ...d } : (d ?? null)
        } else {
          const key = p.slice(0, dot)
          next[key] = { ...(next[key] || {}), [p.slice(dot + 1)]: valueAt(defaults, p) ?? null }
        }
      }
      return next
    })
  }

  const orgSets = (field) => field.paths.some(p => isOverridden(set, p))
  // Only values that will actually be stored count (a field marked set but
  // left blank stores nothing).
  const pending = values ? newlyAppliedFields(ORG_FIELDS, loadedSet, nonBlankSetPaths(set, values), studios) : []
  // A half-entered window would be dropped on Save: say so and hold Save.
  const quietHalf = !!values && isHalfQuietWindow(values.quiet_hours)

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch(ORG_API, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOrgSavePayload(values, set, organizationId)),
      })
      const j = await res.json()
      if (j.success && j.data) {
        apply(j.data); setSavedAt(Date.now())
        if (onSaved) await onSaved()
      } else setError(j.error || 'Failed to save')
    } catch { setError('Failed to save') } finally { setSaving(false) }
  }

  // T4-C — a preview first (what the copy sets, who starts using it), then
  // the write. The studio itself is never changed.
  const source = studios.find(s => s.id === copyFrom) || null
  const copyFields = source
    ? ORG_FIELDS.filter(f => f.paths.some(p => isOverridden(copyablePaths(source.sets), p)))
    : []
  const copyNewlyApplied = source
    // Against what is STORED (the copy merges into the stored layer).
    ? newlyAppliedFields(copyFields, loadedSet, withOverride(loadedSet, ...copyablePaths(source.sets)), studios)
    : []

  async function copyNow() {
    setSaving(true); setError(null)
    try {
      const res = await fetch(ORG_API, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, copy_from_location_id: copyFrom }),
      })
      const j = await res.json()
      if (j.success && j.data) {
        apply(j.data); setSavedAt(Date.now()); setCopyPreview(false)
        if (onSaved) await onSaved()
      } else setError(j.error || 'Could not copy that studio\'s settings')
    } catch { setError('Could not copy that studio\'s settings') } finally { setSaving(false) }
  }

  function tag(field) {
    if (orgSets(field)) {
      return (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs underline" onClick={() => clear(field)}>
          Use default
        </Button>
      )
    }
    return (
      <span className="text-[11px] rounded-full border border-un1t-border px-2 py-0.5 text-un1t-muted whitespace-nowrap">Default</span>
    )
  }

  function control(field, props) {
    const path = field.paths[0]
    const v = valueAt(values, path)
    if (field.kind === 'textarea') {
      return <textarea {...props} className={inputCls} rows={2} maxLength={field.maxLength} value={v || ''}
        placeholder={field.placeholder} onChange={e => edit(field, path, e.target.value)} />
    }
    if (field.kind === 'number') {
      return <input {...props} type="number" className={inputCls} min={field.min} max={field.max} step={field.step}
        value={v ?? ''} placeholder={field.placeholder ?? (valueAt(defaults, path) != null ? String(valueAt(defaults, path)) : undefined)}
        onChange={e => edit(field, path, e.target.value === '' ? null : Number(e.target.value))} />
    }
    if (field.kind === 'select') {
      return (
        <select {...props} className={inputCls} value={v || ''} onChange={e => edit(field, path, e.target.value || null)}>
          {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      )
    }
    if (field.kind === 'quiet_hours') {
      return (
        <div className="flex items-center gap-2 text-sm">
          <input {...props} type="time" aria-label="Quiet hours start" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
            value={values.quiet_hours?.start || ''} onChange={e => editQuiet('start', e.target.value)} />
          <span className="text-un1t-muted">to</span>
          <input type="time" aria-label="Quiet hours end" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
            value={values.quiet_hours?.end || ''} onChange={e => editQuiet('end', e.target.value)} />
          {quietHalf && <span className="text-xs text-red-600" role="alert">Set both times</span>}
        </div>
      )
    }
    return <input {...props} className={inputCls} maxLength={field.maxLength} value={v || ''}
      placeholder={field.placeholder} onChange={e => edit(field, path, e.target.value)} />
  }

  function renderField(field) {
    const line = describeInheritance(field.paths, studios)
    if (field.kind === 'checkbox') {
      const path = field.paths[0]
      return (
        <div key={field.id} data-org-field={field.id}>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-un1t-text">
              <input type="checkbox" checked={path === 'inline_suggestion.enabled' ? valueAt(values, path) !== false : !!valueAt(values, path)}
                onChange={e => edit(field, path, e.target.checked)} />
              {field.label}
            </label>
            {tag(field)}
          </div>
          <p className="text-xs text-un1t-subtle mt-1">{line}</p>
        </div>
      )
    }
    return (
      <div key={field.id} className="relative" data-org-field={field.id}>
        <div className="absolute right-0 top-0">{tag(field)}</div>
        <Field id={`org-${field.id}`} label={field.label} hint={field.help}>
          {(props) => control(field, props)}
        </Field>
        <p className="text-xs text-un1t-subtle mt-1">{line}</p>
      </div>
    )
  }

  return (
    <section className="border border-un1t-border rounded-lg p-5 mb-6" aria-labelledby="org-defaults-heading">
      <h2 id="org-defaults-heading" className="text-base font-semibold text-un1t-text mb-1">Organisation defaults (all studios)</h2>
      <p className="text-sm text-un1t-muted mb-4">
        Studios use these unless they set their own.{orgName ? ` These apply to every studio in ${orgName}.` : ''}
      </p>

      {loading && <div className="text-sm text-un1t-muted">Loading…</div>}
      {!loading && (loadFailed || !values) && (
        <ReadFailedNote what="the organisation defaults" onRetry={reload} />
      )}

      {!loading && !loadFailed && values && (
        <div className="space-y-6">
          {/* T4-C — start from a studio's settings */}
          {studios.length > 0 && (
            <div className="rounded-md border border-un1t-border bg-un1t-bg/40 p-3 space-y-2">
              <Field id="org-copy-from" label="Start from a studio's settings"
                hint="Copies that studio's own values into these defaults, replacing the matching organisation values. Values the studio does not set are left as they are. The studio itself is not changed.">
                {(props) => (
                  <div className="flex items-center gap-2">
                    <select {...props} className={inputCls} value={copyFrom}
                      onChange={e => { setCopyFrom(e.target.value); setCopyPreview(false) }}>
                      <option value="">Choose a studio</option>
                      {studios.map(s => <option key={s.id} value={s.id}>{s.name || 'Unnamed studio'}</option>)}
                    </select>
                    <Button variant="secondary" size="sm" disabled={!copyFrom || saving} onClick={() => setCopyPreview(true)}>
                      Review copy
                    </Button>
                  </div>
                )}
              </Field>
              {copyPreview && source && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 space-y-1" role="status">
                  {copyFields.length === 0 ? (
                    <p>{source.name || 'That studio'} sets none of these values itself, so there is nothing to copy.</p>
                  ) : (
                    <>
                      <p>This sets {copyFields.length} organisation {copyFields.length === 1 ? 'value' : 'values'} from {source.name || 'that studio'}: {copyFields.map(f => f.label).join(', ')}.</p>
                      {copyNewlyApplied.map(n => <p key={n.field.id}>{describeNewlyApplied(n)}</p>)}
                    </>
                  )}
                  <div className="flex gap-2 pt-1">
                    {copyFields.length > 0 && (
                      <Button size="sm" loading={saving} onClick={copyNow}>Copy now</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setCopyPreview(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {ORG_FIELD_GROUPS.map(group => (
            <div key={group.id} className="space-y-4">
              <h3 className="text-sm font-semibold text-un1t-text">{group.title}</h3>
              {group.fields.map(renderField)}
            </div>
          ))}

          {/* T4-A — before the save: who starts using a value the organisation did not set before. */}
          {pending.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 space-y-1" role="status" data-testid="org-newly-applied">
              <p className="font-semibold">Saving starts these for studios that do not set their own:</p>
              {pending.map(n => <p key={n.field.id}>{describeNewlyApplied(n)}</p>)}
            </div>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
          <div>
            <Button loading={saving} disabled={quietHalf} onClick={save}>Save organisation defaults</Button>
            {savedAt && <span className="ml-3 text-sm text-green-600">Saved</span>}
          </div>
        </div>
      )}
    </section>
  )
}
