'use client'

// STATUS-PAGE.2 — operator editor for the public status page copy. Self-fetches
// /api/settings/status-page, edits the locations.settings.status_page override
// shape, and saves it back. Every field's placeholder is the shipped default,
// so a blank field means "use the default" — nothing has to be filled in.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'
import { ExternalLink } from 'lucide-react'
import {
  OVERRIDE_SERVICE_KEYS,
  OVERRIDE_VERDICT_KEYS,
} from '@/lib/status-page'

const VERDICT_TITLE = {
  operational: 'When everything is operational',
  degraded: 'When something is degraded',
  down: 'When a service is down',
}

function emptyForm() {
  const services = {}
  for (const k of OVERRIDE_SERVICE_KEYS) services[k] = { label: '', ok: '', bad: '' }
  const verdict = {}
  for (const k of OVERRIDE_VERDICT_KEYS) verdict[k] = { tag: '', headline: '', subline: '' }
  return { brand: '', services, verdict }
}

// Merge saved (partial) overrides onto the empty shape so every input is controlled.
function hydrate(overrides) {
  const f = emptyForm()
  const o = overrides || {}
  if (typeof o.brand === 'string') f.brand = o.brand
  for (const k of OVERRIDE_SERVICE_KEYS) {
    Object.assign(f.services[k], o.services?.[k] || {})
  }
  for (const k of OVERRIDE_VERDICT_KEYS) {
    Object.assign(f.verdict[k], o.verdict?.[k] || {})
  }
  return f
}

export default function StatusPageSettingsForm() {
  const [form, setForm] = useState(emptyForm())
  const [defaults, setDefaults] = useState(null)
  const [publicPath, setPublicPath] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/settings/status-page')
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok && data.success) {
          setForm(hydrate(data.overrides))
          setDefaults(data.defaults || null)
          setPublicPath(data.publicPath || null)
        } else {
          setError(data.error || 'Could not load settings')
        }
      } catch {
        if (!cancelled) setError('Could not load settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function setSvc(key, field, value) {
    setSaved(false)
    setForm((f) => ({ ...f, services: { ...f.services, [key]: { ...f.services[key], [field]: value } } }))
  }
  function setVerdict(key, field, value) {
    setSaved(false)
    setForm((f) => ({ ...f, verdict: { ...f.verdict, [key]: { ...f.verdict[key], [field]: value } } }))
  }

  async function save(next) {
    const payload = next || form
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/status-page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) { setSaved(true); setForm(hydrate(data.overrides)) }
      else setError(data.error || 'Could not save')
    } catch {
      setError('Could not save')
    } finally {
      setSaving(false)
    }
  }

  function resetToDefaults() {
    const blank = emptyForm()
    setForm(blank)
    save(blank)
  }

  if (loading) return <p className="text-sm text-un1t-subtle">Loading…</p>

  const d = defaults || {}

  return (
    <div className="space-y-8">
      {publicPath ? (
        <Link
          href={`/welcome/${publicPath}/status`}
          target="_blank"
          className="inline-flex items-center gap-1.5 text-sm text-mia hover:underline font-medium"
        >
          View the live status page <ExternalLink size={13} />
        </Link>
      ) : (
        <p className="text-xs text-un1t-subtle">This location has no public page path yet, so the status page isn’t reachable publicly.</p>
      )}

      {/* Brand */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-un1t-text">Brand name</h2>
        <input
          type="text"
          value={form.brand}
          onChange={(e) => { setSaved(false); setForm((f) => ({ ...f, brand: e.target.value })) }}
          placeholder={d.brand || 'UN1T'}
          className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-subtle"
        />
      </section>

      {/* Overall verdict states */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-un1t-text">Overall status message</h2>
        {OVERRIDE_VERDICT_KEYS.map((k) => (
          <div key={k} className="rounded-lg border border-un1t-border p-4 space-y-3 bg-un1t-surface">
            <div className="text-xs font-semibold uppercase tracking-wider text-un1t-muted">{VERDICT_TITLE[k]}</div>
            <Labeled label="Badge">
              <input type="text" value={form.verdict[k].tag} placeholder={d.verdict?.[k]?.tag || ''}
                onChange={(e) => setVerdict(k, 'tag', e.target.value)} className={INPUT} />
            </Labeled>
            <Labeled label="Headline">
              <input type="text" value={form.verdict[k].headline} placeholder={d.verdict?.[k]?.headline || ''}
                onChange={(e) => setVerdict(k, 'headline', e.target.value)} className={INPUT} />
            </Labeled>
            <Labeled label="Message">
              <textarea rows={2} value={form.verdict[k].subline} placeholder={d.verdict?.[k]?.subline || ''}
                onChange={(e) => setVerdict(k, 'subline', e.target.value)} className={INPUT} />
            </Labeled>
          </div>
        ))}
      </section>

      {/* Per-service copy */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-un1t-text">Services</h2>
        {OVERRIDE_SERVICE_KEYS.map((k) => (
          <div key={k} className="rounded-lg border border-un1t-border p-4 space-y-3 bg-un1t-surface">
            <div className="text-xs font-semibold uppercase tracking-wider text-un1t-muted">{d.services?.[k]?.label || k}</div>
            <Labeled label="Service name">
              <input type="text" value={form.services[k].label} placeholder={d.services?.[k]?.label || ''}
                onChange={(e) => setSvc(k, 'label', e.target.value)} className={INPUT} />
            </Labeled>
            <Labeled label="When operational">
              <input type="text" value={form.services[k].ok} placeholder={d.services?.[k]?.ok || ''}
                onChange={(e) => setSvc(k, 'ok', e.target.value)} className={INPUT} />
            </Labeled>
            <Labeled label="When there’s a problem">
              <input type="text" value={form.services[k].bad} placeholder={d.services?.[k]?.bad || ''}
                onChange={(e) => setSvc(k, 'bad', e.target.value)} className={INPUT} />
            </Labeled>
          </div>
        ))}
      </section>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="flex items-center gap-3">
        <Button onClick={() => save()} loading={saving} variant="primary">Save</Button>
        <Button onClick={resetToDefaults} variant="ghost" disabled={saving}>Reset to defaults</Button>
        {saved ? <span className="text-sm text-green-700">Saved ✓</span> : null}
      </div>
    </div>
  )
}

const INPUT = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-subtle'

function Labeled({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-un1t-subtle mb-1">{label}</span>
      {children}
    </label>
  )
}
