'use client'

// WAYSIN.4 — the studio's corporate and partner promos (/settings/promos):
// free classes behind a claim link, one row per key in public.corp_promos
// (mig 816). Reads and writes through /api/locations/[id]/corp-promos.
//
// Managers see the list; owners and masters (can_edit) create, edit, switch on
// and off and delete. A promo's key is its claim link and cannot change after
// it is created; Delete shows only on a switched-off promo (the API refuses a
// live one: 409 still_live), and a promo that has claims can only be switched
// off (the API's 409 has_claims disables its Delete). A refused save names the
// field in words (FIELD_MESSAGES), never the validator's raw text. The Glofox plan fields show only at a
// Glofox studio, where they are required.
//
// No server-only import: this is a client module, so it never touches
// corp-promos-db.js (tests/corp-promos-client-safe.test.js).

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Power } from 'lucide-react'
import { Button, Card, Field, Loading, EmptyState } from '@/components/ui'

const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-60'
const LIVE_CHIP = 'bg-green-500/10 text-green-700'
const OFF_CHIP = 'bg-gray-500/10 text-gray-700'

const EMPTY_FORM = Object.freeze({
  key: '', name: '', credits: '3', expires_in_days: '7', tag: '', lead_source: 'corp_promo',
  glofox_membership_id: '', glofox_plan_code: '', glofox_plan_name: '',
})

function formFromPromo(p) {
  return {
    key: p.key || '',
    name: p.name || '',
    credits: String(p.credits ?? ''),
    expires_in_days: String(p.expiresInDays ?? ''),
    tag: p.tag || '',
    lead_source: p.leadSource || '',
    glofox_membership_id: p.glofox?.membershipId || '',
    glofox_plan_code: p.glofox?.planCode || '',
    glofox_plan_name: p.glofox?.planName || '',
  }
}

/** The body a save sends: numbers as numbers, the Glofox fields only at a Glofox studio, the key only on create. */
export function promoBodyFromForm(form, { platform, creating }) {
  const body = {
    name: form.name.trim(),
    credits: Number(form.credits),
    expires_in_days: Number(form.expires_in_days),
    tag: form.tag.trim().toLowerCase(),
    lead_source: form.lead_source.trim().toLowerCase(),
  }
  if (creating) body.key = form.key.trim().toLowerCase()
  if (platform === 'glofox') {
    body.glofox_membership_id = form.glofox_membership_id.trim()
    body.glofox_plan_code = form.glofox_plan_code.trim()
    body.glofox_plan_name = form.glofox_plan_name.trim()
  }
  return body
}

// A refused field in words. The route's issues carry a path (validateBody);
// the zod message behind it never reaches the operator.
export const FIELD_MESSAGES = Object.freeze({
  // Create refuses a malformed key; an edit refuses any key at all (it is the
  // promo's claim link), so the message covers both.
  key: 'Check the Key: 3 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. A promo\'s key cannot be changed after it is created.',
  name: 'Enter a name, up to 80 characters.',
  credits: 'Credits must be a whole number from 1 to 50.',
  expires_in_days: 'Expiry must be a whole number of days from 1 to 365.',
  tag: 'Check the Tag: 2 to 40 lowercase letters, digits, - or _.',
  lead_source: 'Check the Lead source: letters, digits, _ or - (no spaces), up to 80 characters.',
  glofox_membership_id: 'Check the Glofox membership id.',
  glofox_plan_code: 'Check the Glofox plan code.',
  glofox_plan_name: 'Check the Glofox plan name.',
  live: 'Check the Live switch.',
})
const UNKNOWN_FIELD = 'Some of the details are not valid. Check the form and try again.'

/** The words for a refused request: each named field once, else the API's own error. */
export function apiError(j, status) {
  if (Array.isArray(j?.issues) && j.issues.length) {
    const fields = [...new Set(j.issues.map((i) => String(i?.path || '').split('.')[0]))]
    return [...new Set(fields.map((f) => FIELD_MESSAGES[f] || UNKNOWN_FIELD))].join(' ')
  }
  return j?.error || `Request failed (${status})`
}

/** What is missing before a save is sent, in words; null when nothing is. */
export function missingField(form) {
  if (!form.name.trim()) return 'Enter a name.'
  if (!String(form.credits).trim()) return 'Enter the credits.'
  if (!String(form.expires_in_days).trim()) return 'Enter the expiry in days.'
  return null
}

function TextInput({ id, label, hint, value, onChange, disabled, maxLength = 80, inputMode, required }) {
  return (
    <Field id={id} label={label} hint={hint} required={required}>
      {(props) => (
        <input {...props} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}
          disabled={disabled} maxLength={maxLength} inputMode={inputMode} />
      )}
    </Field>
  )
}

function PromoForm({ initial, creating, platform, publicPath, onCancel, onSaved, locationId, promoId }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const keyPreview = form.key.trim().toLowerCase() || 'your-key'

  async function submit(e) {
    e.preventDefault()
    const missing = missingField(form)
    if (missing) { setError(missing); return }
    setSaving(true); setError(null)
    try {
      const url = creating
        ? `/api/locations/${encodeURIComponent(locationId)}/corp-promos`
        : `/api/locations/${encodeURIComponent(locationId)}/corp-promos/${encodeURIComponent(promoId)}`
      const res = await fetch(url, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promoBodyFromForm(form, { platform, creating })),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) { setError(apiError(j, res.status)); return }
      onSaved(j.data.promo)
    } catch {
      setError('Save failed. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="border border-un1t-border rounded-lg bg-un1t-bg p-4 space-y-3" aria-label={creating ? 'New promo' : `Edit ${initial.name}`}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TextInput id="promo-name" label="Name" value={form.name} onChange={(v) => set({ name: v })} required />
        <TextInput id="promo-key" label="Key" value={form.key} onChange={(v) => set({ key: v })} disabled={!creating} maxLength={40} required
          hint={creating
            ? `Claim link: /${publicPath || '<studio>'}/… with promo ${keyPreview}. It cannot be changed later.`
            : 'The key is the claim link and cannot be changed.'} />
        <TextInput id="promo-credits" label="Credits" value={form.credits} onChange={(v) => set({ credits: v })} maxLength={2} inputMode="numeric" hint="1 to 50 free classes." required />
        <TextInput id="promo-expiry" label="Expiry (days)" value={form.expires_in_days} onChange={(v) => set({ expires_in_days: v })} maxLength={3} inputMode="numeric" hint="How long the credits last, 1 to 365 days." required />
        <TextInput id="promo-tag" label="Tag" value={form.tag} onChange={(v) => set({ tag: v })} maxLength={40} hint="Put on every claimant. Lowercase letters, digits, - or _." required />
        <TextInput id="promo-lead-source" label="Lead source" value={form.lead_source} onChange={(v) => set({ lead_source: v })} hint="What the reports carry: letters, digits, _ or -, no spaces. Stored in lowercase." />
      </div>
      {platform === 'glofox' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-un1t-border">
          <TextInput id="promo-glofox-membership" label="Glofox membership id" value={form.glofox_membership_id} onChange={(v) => set({ glofox_membership_id: v })} maxLength={200} required />
          <TextInput id="promo-glofox-plan-code" label="Glofox plan code" value={form.glofox_plan_code} onChange={(v) => set({ glofox_plan_code: v })} maxLength={200} required />
          <TextInput id="promo-glofox-plan-name" label="Glofox plan name" value={form.glofox_plan_name} onChange={(v) => set({ glofox_plan_name: v })} maxLength={200} required />
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" loading={saving}>{creating ? 'Create promo' : 'Save promo'}</Button>
      </div>
    </form>
  )
}

export default function CorpPromosCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [promos, setPromos] = useState([])
  const [canEdit, setCanEdit] = useState(false)
  const [platform, setPlatform] = useState(null)
  const [publicPath, setPublicPath] = useState(null)
  const [editing, setEditing] = useState(null)      // 'new' | promo id | null
  const [hasClaims, setHasClaims] = useState({})    // promo id → true after a 409
  const [rowError, setRowError] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/locations/${encodeURIComponent(locationId)}/corp-promos`, { cache: 'no-store' })
      .then(async (r) => ({ r, j: await r.json().catch(() => ({})) }))
      .then(({ r, j }) => {
        if (cancelled) return
        if (!r.ok || !j?.success) { setLoadError(apiError(j, r.status)); return }
        setPromos(Array.isArray(j.data.promos) ? j.data.promos : [])
        setCanEdit(Boolean(j.data.can_edit))
        setPlatform(j.data.platform || null)
        setPublicPath(j.data.public_path || null)
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load the promos') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const upsert = useCallback((promo) => {
    setPromos((list) => {
      const rest = list.filter((p) => p.id !== promo.id)
      return [...rest, promo].sort((a, b) => a.key.localeCompare(b.key))
    })
    setEditing(null)
  }, [])

  async function toggle(promo) {
    setBusy(promo.id); setRowError(null)
    try {
      const res = await fetch(`/api/locations/${encodeURIComponent(locationId)}/corp-promos/${encodeURIComponent(promo.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: !promo.live }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) { setRowError(apiError(j, res.status)); return }
      upsert(j.data.promo)
    } catch {
      setRowError('Could not change the promo. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  async function remove(promo) {
    if (!window.confirm(`Delete ${promo.name}? Its claim link stops working.`)) return
    setBusy(promo.id); setRowError(null)
    try {
      const res = await fetch(`/api/locations/${encodeURIComponent(locationId)}/corp-promos/${encodeURIComponent(promo.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409 && j.code === 'has_claims') { setHasClaims((m) => ({ ...m, [promo.id]: true })); return }
      if (!res.ok || j.success === false) { setRowError(apiError(j, res.status)); return }
      setPromos((list) => list.filter((p) => p.id !== promo.id))
    } catch {
      setRowError('Could not delete the promo. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Card title="Promos"><Loading /></Card>
  if (loadError) return <Card title="Promos"><p role="alert" className="text-sm text-red-700">{loadError}</p></Card>

  const noPlatform = !platform
  return (
    <Card
      title="Promos"
      actions={canEdit && !noPlatform && editing !== 'new'
        ? <Button type="button" size="sm" icon={Plus} onClick={() => setEditing('new')}>New promo</Button>
        : null}
    >
      <div className="space-y-3">
        {noPlatform && (
          <p className="text-sm text-un1t-subtle">This studio has no membership platform (Glofox or un1t.online), so it cannot grant promo credits.</p>
        )}
        {editing === 'new' && (
          <PromoForm initial={{ ...EMPTY_FORM }} creating platform={platform} publicPath={publicPath} locationId={locationId}
            onCancel={() => setEditing(null)} onSaved={upsert} />
        )}
        {rowError && <p role="alert" className="text-xs text-red-700">{rowError}</p>}
        {promos.length === 0 && editing !== 'new' && (
          <EmptyState title="No promos yet" description="A promo gives free classes to anyone with its claim link." />
        )}
        <ul className="space-y-3">
          {promos.map((p) => (
            <li key={p.id} className="border border-un1t-border rounded-lg p-3 space-y-2">
              {editing === p.id ? (
                <PromoForm initial={formFromPromo(p)} creating={false} platform={p.platform} publicPath={publicPath} locationId={locationId}
                  promoId={p.id} onCancel={() => setEditing(null)} onSaved={upsert} />
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-un1t-text">{p.name}</p>
                      <p className="text-xs text-un1t-subtle">{`${p.key} · ${p.credits} credits for ${p.expiresInDays} days · tag ${p.tag} · source ${p.leadSource}`}</p>
                    </div>
                    <span className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${p.live ? LIVE_CHIP : OFF_CHIP}`}>{p.live ? 'Live' : 'Off'}</span>
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" size="sm" icon={Power} loading={busy === p.id}
                        onClick={() => toggle(p)}>{p.live ? 'Switch off' : 'Switch on'}</Button>
                      <Button type="button" variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(p.id)}>Edit</Button>
                      {!p.live && (
                        <Button type="button" variant="danger" size="sm" icon={Trash2} disabled={hasClaims[p.id] || busy === p.id}
                          onClick={() => remove(p)}>{hasClaims[p.id] ? 'Delete (has claims)' : 'Delete'}</Button>
                      )}
                    </div>
                  )}
                  {hasClaims[p.id] && (
                    <p className="text-xs text-un1t-subtle">This promo has claims, so it can only be switched off.</p>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
