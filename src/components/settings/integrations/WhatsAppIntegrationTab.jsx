'use client'

// WA-MULTI.1 — WhatsApp Cloud API numbers tab.
//
// One location can have multiple registered numbers (e.g. one
// Cloud API number + one Coexistence-mode mobile number). Each
// row is a `whatsapp_numbers` record. Operators add/edit/remove
// numbers and pick which is default for outbound.
//
// Tokens are NEVER returned in plain by the API — the list shows
// the last 6 chars masked behind dots. Editing the token requires
// pasting the new full value; the field starts empty and is only
// sent on the wire when non-empty.

import { useEffect, useState } from 'react'
import {
  Plus, Trash2, Star, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight,
  ExternalLink,
} from 'lucide-react'

export default function WhatsAppIntegrationTab({ location, canEdit }) {
  const [numbers, setNumbers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to load numbers')
      setNumbers(j.numbers || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">WhatsApp numbers</h4>
        <p className="text-xs text-un1t-subtle">
          Register the WhatsApp Cloud API numbers active at this location. One number is the
          <span className="font-medium"> default</span> — outbound sends from broadcasts,
          sequences, and the inbox route through it. Inbound webhooks land at whichever
          number Meta posted to.
        </p>
        <p className="text-[11px] text-un1t-muted mt-1">
          Coexistence (linking an existing WhatsApp Business mobile number) requires Meta-side
          approval on our Tech Provider account.{' '}
          <a
            href="https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
          >
            Meta docs <ExternalLink size={9} />
          </a>{' '}
          — set <code>source = coexistence</code> on the row once the mobile number is registered.
        </p>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {numbers.length === 0 && (
              <div className="text-xs text-un1t-subtle bg-un1t-bg border border-un1t-border rounded p-3">
                No numbers configured. This location falls back to the global
                <code className="text-un1t-muted"> WHATSAPP_*</code> env vars (legacy single-number setup).
                Add a number below to migrate.
              </div>
            )}
            {numbers.map((n) => (
              <NumberRow
                key={n.id}
                location={location}
                number={n}
                canEdit={canEdit}
                expanded={expandedId === n.id}
                onExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                onReload={load}
                onError={setError}
              />
            ))}
          </div>

          {canEdit && (
            adding ? (
              <AddNumberForm
                locationId={location.id}
                onCancel={() => setAdding(false)}
                onSaved={() => { setAdding(false); load() }}
                onError={setError}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent"
              >
                <Plus size={12} /> Add WhatsApp number
              </button>
            )
          )}
        </>
      )}
    </div>
  )
}

function NumberRow({ location, number, canEdit, expanded, onExpand, onReload, onError }) {
  const [busy, setBusy] = useState(false)

  async function setDefault() {
    if (!canEdit || number.is_default) return
    setBusy(true)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers/${number.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to set default')
      onReload()
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!canEdit) return
    if (!confirm(`Remove "${number.label}"? Any sends to / from this number will fall back to the location's other configured number, or the env-var default.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/locations/${location.id}/whatsapp/numbers/${number.id}`, { method: 'DELETE' })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to remove')
      onReload()
    } catch (e) { onError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md">
      <div className="flex items-center justify-between p-3 gap-3">
        <button type="button" onClick={onExpand} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-un1t-text truncate">{number.label}</span>
              {number.is_default && (
                <span className="inline-flex items-center gap-0.5 text-[10px] uppercase text-amber-400">
                  <Star size={10} className="fill-amber-400" /> Default
                </span>
              )}
              {!number.is_active && (
                <span className="text-[10px] uppercase text-un1t-muted">Inactive</span>
              )}
              <span className="text-[10px] uppercase text-un1t-muted">
                {number.source === 'coexistence' ? 'Coexistence' : 'Cloud API'}
              </span>
            </div>
            <div className="text-[11px] text-un1t-subtle truncate">
              {number.display_phone || number.phone_number_id}
              <span className="mx-1.5 text-un1t-muted">·</span>
              <span className="text-un1t-muted">PhoneNumberID:</span> {number.phone_number_id}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {canEdit && !number.is_default && (
            <button
              type="button"
              onClick={setDefault}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[10px] text-un1t-subtle hover:text-amber-400 disabled:opacity-50"
              title="Make this the default outbound number"
            >
              <Star size={11} /> Set default
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={remove} disabled={busy} className="text-un1t-subtle hover:text-red-500 p-1 disabled:opacity-50">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <EditNumberForm
          locationId={location.id}
          number={number}
          canEdit={canEdit}
          onSaved={onReload}
          onError={onError}
        />
      )}
    </div>
  )
}

const FIELD_HELP = {
  phone_number_id: 'Meta\'s PHONE_NUMBER_ID for this number. Find it under Meta Business → WhatsApp → API Setup.',
  business_account_id: 'WhatsApp Business Account ID (WABA). Required for template management.',
  app_id: 'Meta App ID. Required for the template media-upload flow.',
  access_token: 'Permanent system-user access token. Generated via Meta Business Manager → Users → System Users.',
}

function AddNumberForm({ locationId, onCancel, onSaved, onError }) {
  const [form, setForm] = useState({
    label: '', phone_number_id: '', access_token: '',
    business_account_id: '', app_id: '', display_phone: '',
    source: 'cloud_api', is_default: false,
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const body = { ...form }
      // Strip empty optional strings — schema rejects empty for some.
      for (const k of ['business_account_id', 'app_id', 'display_phone']) {
        if (!body[k]) delete body[k]
      }
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to add number')
      onSaved()
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <h5 className="text-xs font-semibold text-un1t-text">Add WhatsApp number</h5>
      <Row label="Label" hint="A short name for the operator UI (e.g. 'Stillorgan mobile')">
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Phone Number ID" hint={FIELD_HELP.phone_number_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value.trim() })} />
      </Row>
      <Row label="Display phone" hint="Friendly format for the UI, e.g. +353 1 234 5678">
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="Access token" hint={FIELD_HELP.access_token}>
        <textarea rows={2} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
      </Row>
      <Row label="WABA ID" hint={FIELD_HELP.business_account_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID" hint={FIELD_HELP.app_id}>
        <input className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row label="Source">
        <select className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
          <option value="cloud_api">Cloud API</option>
          <option value="coexistence">Coexistence (mobile + API)</option>
        </select>
      </Row>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
        Make this the default outbound number for this location
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !form.label.trim() || !form.phone_number_id.trim() || !form.access_token.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="text-[11px] text-un1t-subtle hover:text-un1t-text">
          Cancel
        </button>
      </div>
    </div>
  )
}

function EditNumberForm({ locationId, number, canEdit, onSaved, onError }) {
  const [form, setForm] = useState({
    label: number.label || '',
    display_phone: number.display_phone || '',
    business_account_id: number.business_account_id || '',
    app_id: number.app_id || '',
    is_active: number.is_active,
    new_access_token: '', // empty by default — only sent on save if non-empty
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const updates = {
        label: form.label.trim() || undefined,
        display_phone: form.display_phone || null,
        business_account_id: form.business_account_id || null,
        app_id: form.app_id || null,
        is_active: form.is_active,
      }
      if (form.new_access_token.trim()) {
        updates.access_token = form.new_access_token.trim()
      }
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers/${number.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save')
      onSaved()
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-un1t-border p-3 space-y-2 bg-un1t-surface/30">
      <Row label="Label">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Display phone">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="WABA ID">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID">
        <input disabled={!canEdit} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row label="Current token" hint="Stored value (last 6 chars shown). To change, paste a new token below.">
        <code className="block w-full bg-un1t-surface/50 border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-muted">
          {number.access_token_redacted || '••••'}
        </code>
      </Row>
      <Row label="New access token (leave blank to keep current)">
        <textarea disabled={!canEdit} rows={2} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono" value={form.new_access_token} onChange={(e) => setForm({ ...form, new_access_token: e.target.value })} />
      </Row>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input type="checkbox" disabled={!canEdit} checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Active (uncheck to disable without deleting — useful for temporary maintenance)
      </label>
      {canEdit && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

function Row({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-un1t-muted mt-0.5">{hint}</div>}
    </label>
  )
}
