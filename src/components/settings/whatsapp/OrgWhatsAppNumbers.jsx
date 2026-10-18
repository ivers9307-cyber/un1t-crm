'use client'

// WAORGNUMBER.1 (Task 5, R8) — the organisation's WhatsApp numbers.
//
// A number belongs to the ORGANISATION and is switched on per studio. This is
// where an organisation admin (or a master) adds, edits and removes them,
// chooses a number's HOME studio (where new-enquiry threads and coexistence
// history land) and runs Embedded Signup. It holds what the studio's
// integrations tab used to: the add form, the edit form and the Embedded
// Signup card (the card stays its own module, imported by this page).
//
// Tokens are NEVER returned in plain by the API, and the stored token is
// never shown (the API returns a fixed mask; N8NECHO.1). Editing the token
// requires pasting the new full value; the field starts empty and is only
// sent on the wire when non-empty.
//
// Routes: /api/organizations/[id]/whatsapp/numbers (+ [numberId], and
// embedded-signup in the card). A new number is switched on at its home
// studio by the database; every other studio switches it on from its own
// integrations tab.

import { useEffect, useState } from 'react'
import {
  Plus, Trash2, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight, ExternalLink,
} from 'lucide-react'
import { effectiveHistorySyncStatus } from '@/lib/whatsapp-coexistence'
import { ACTIVE_CHECKBOX_LABEL, removeNumberConfirm, deactivateNumberConfirm } from '@/lib/whatsapp-number-copy'
import { ConnectWhatsAppCard } from '@/components/settings/integrations/ConnectWhatsAppCard'
import { Row } from '@/components/settings/integrations/WhatsAppFieldRow'
import ReadFailedNote from '@/components/settings/ReadFailedNote'

const INPUT = 'w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text'

const HISTORY_SYNC_NOTES = {
  pending: 'History: importing recent chats…',
  importing: 'History: importing recent chats…',
  imported: 'History imported',
  complete: 'History imported',
  declined: 'History sharing was declined',
  expired: 'History import window expired',
}

const FIELD_HELP = {
  phone_number_id: 'Meta\'s PHONE_NUMBER_ID for this number. Find it under Meta Business → WhatsApp → API Setup.',
  business_account_id: 'WhatsApp Business Account ID (WABA). Required for template management.',
  app_id: 'Meta App ID. Required for the template media-upload flow.',
  access_token: 'Permanent system-user access token. Generated via Meta Business Manager → Users → System Users.',
  home_location_id: 'Where the number is switched on first, and where new-enquiry threads and coexistence history land.',
}

export default function OrgWhatsAppNumbers({ organizationId, organizationName, locations }) {
  // CHANNELREAD.1 — `numbers` is null until a read SUCCEEDS, and a failed read
  // puts it back to null: no "No numbers", no Add, no Connect card over a list
  // we could not read. `error` stays for the row actions, which report through it.
  const [numbers, setNumbers] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  const base = `/api/organizations/${organizationId}/whatsapp`

  // silent: refresh in place without the loading flip — the Connect card lives
  // inside the `loading ?` conditional, so a non-silent reload would unmount it
  // and its success chip mid-celebration.
  async function load({ silent = false } = {}) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${base}/numbers`)
      const j = await res.json()
      if (!res.ok || !j.success || !Array.isArray(j.numbers)) throw new Error(j.error || 'Failed to load numbers')
      setNumbers(j.numbers)
    } catch {
      setNumbers(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-un1t-subtle">
          These numbers belong to {organizationName || 'the organisation'}. Each one is switched on at its home
          studio when you add it, and each studio switches numbers on or off, and chooses its default, from its own
          Integrations tab.
        </p>
        <p className="text-[11px] text-un1t-muted mt-1">
          Coexistence (linking an existing WhatsApp Business mobile number) requires Meta-side
          approval on our Tech Provider account.{' '}
          <a
            href="https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-700 hover:underline"
          >
            Meta docs <ExternalLink size={9} />
          </a>{' '}
          — set <code>source = coexistence</code> on the row once the mobile number is registered.
        </p>
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : numbers === null ? (
        <ReadFailedNote what="this organisation's WhatsApp numbers" onRetry={() => load({ silent: true })} />
      ) : (
        <>
          <div className="space-y-2">
            {numbers.length === 0 && (
              <div className="text-xs text-un1t-subtle bg-un1t-bg border border-un1t-border rounded p-3">
                No numbers yet. A studio will not send or receive WhatsApp until a number is switched on there.
                Add a number below to connect one.
              </div>
            )}
            {numbers.map((n) => (
              <OrgNumberRow
                key={n.id}
                base={base}
                number={n}
                locations={locations}
                expanded={expandedId === n.id}
                onExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                onReload={load}
                onError={setError}
              />
            ))}
          </div>

          {adding ? (
            <AddNumberForm
              base={base}
              locations={locations}
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
          )}

          <ConnectWhatsAppCard
            organizationId={organizationId}
            locations={locations}
            canEdit
            onConnected={() => load({ silent: true })}
          />
        </>
      )}
    </div>
  )
}

function HomeStudioSelect({ value, onChange, locations, disabled }) {
  return (
    <select
      disabled={disabled}
      className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose a studio…</option>
      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  )
}

function OrgNumberRow({ base, number, locations, expanded, onExpand, onReload, onError }) {
  const [busy, setBusy] = useState(false)
  const isCoexistence = number.source === 'coexistence'
  const effectiveHistoryStatus = isCoexistence
    ? effectiveHistorySyncStatus(number.history_sync_status, number.history_sync_started_at, Date.now())
    : null
  const historySyncNote = effectiveHistoryStatus ? HISTORY_SYNC_NOTES[effectiveHistoryStatus] : null
  const homeName = locations.find((l) => l.id === number.location_id)?.name || 'Unknown studio'

  async function remove() {
    if (!confirm(removeNumberConfirm(number))) return
    setBusy(true)
    try {
      const res = await fetch(`${base}/numbers/${number.id}`, { method: 'DELETE' })
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
              {!number.is_active && (
                <span className="text-[10px] uppercase text-un1t-muted">Inactive</span>
              )}
              <span className="text-[10px] uppercase text-un1t-muted">
                {isCoexistence ? 'Coexistence' : 'Cloud API'}
              </span>
            </div>
            <div className="text-[11px] text-un1t-subtle truncate">
              {number.display_phone || number.phone_number_id}
              <span className="mx-1.5 text-un1t-muted">·</span>
              <span className="text-un1t-muted">PhoneNumberID:</span> {number.phone_number_id}
            </div>
            <div className="text-[11px] text-un1t-subtle truncate">
              <span className="text-un1t-muted">Home studio:</span> {homeName}
            </div>
            {isCoexistence && historySyncNote && (
              <div className="text-[11px] text-un1t-subtle truncate">{historySyncNote}</div>
            )}
            {isCoexistence && (
              <div className="text-[11px] text-un1t-subtle truncate">
                Coexistence numbers send at up to 5 messages/second, and WhatsApp hides the display name unless the business is Meta-Verified.
              </div>
            )}
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={remove} disabled={busy} title="Remove this number" aria-label="Remove this number" className="text-un1t-subtle hover:text-red-700 p-1 disabled:opacity-50">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <EditNumberForm
          base={base}
          number={number}
          locations={locations}
          onSaved={onReload}
          onError={onError}
        />
      )}
    </div>
  )
}

export function AddNumberForm({ base, locations, onCancel, onSaved, onError }) {
  const [form, setForm] = useState({
    label: '', phone_number_id: '', access_token: '',
    business_account_id: '', app_id: '', display_phone: '',
    source: 'cloud_api',
    home_location_id: locations.length === 1 ? locations[0].id : '',
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
      const res = await fetch(`${base}/numbers`, {
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
        <input className={INPUT} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Home studio" hint={FIELD_HELP.home_location_id}>
        <HomeStudioSelect value={form.home_location_id} locations={locations} onChange={(v) => setForm({ ...form, home_location_id: v })} />
      </Row>
      <Row label="Phone Number ID" hint={FIELD_HELP.phone_number_id}>
        <input className={`${INPUT} font-mono`} value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value.trim() })} />
      </Row>
      <Row label="Display phone" hint="Friendly format for the UI, e.g. +353 1 234 5678">
        <input className={INPUT} value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="Access token" hint={FIELD_HELP.access_token}>
        <textarea rows={2} className={`${INPUT} font-mono`} value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
      </Row>
      <Row label="WABA ID" hint={FIELD_HELP.business_account_id}>
        <input className={`${INPUT} font-mono`} value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID" hint={FIELD_HELP.app_id}>
        <input className={`${INPUT} font-mono`} value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row label="Source">
        <select className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
          <option value="cloud_api">Cloud API</option>
          <option value="coexistence">Coexistence (mobile + API)</option>
        </select>
      </Row>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !form.label.trim() || !form.phone_number_id.trim() || !form.access_token.trim() || !form.home_location_id}
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

export function EditNumberForm({ base, number, locations, onSaved, onError }) {
  const [form, setForm] = useState({
    label: number.label || '',
    display_phone: number.display_phone || '',
    business_account_id: number.business_account_id || '',
    app_id: number.app_id || '',
    is_active: number.is_active,
    home_location_id: number.location_id || '',
    new_access_token: '', // empty by default — only sent on save if non-empty
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    // WACONFIGFALLBACK.1 / WAORGNUMBER.1 — deactivating a number turns it off at
    // every studio that has it switched on: ask first.
    if (number.is_active && !form.is_active) {
      if (!confirm(deactivateNumberConfirm(number))) return
    }
    setSaving(true)
    try {
      const updates = {
        label: form.label.trim() || undefined,
        display_phone: form.display_phone || null,
        business_account_id: form.business_account_id || null,
        app_id: form.app_id || null,
        is_active: form.is_active,
        home_location_id: form.home_location_id || undefined,
      }
      if (form.new_access_token.trim()) {
        updates.access_token = form.new_access_token.trim()
      }
      const res = await fetch(`${base}/numbers/${number.id}`, {
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
        <input className={INPUT} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Row>
      <Row label="Home studio" hint={FIELD_HELP.home_location_id}>
        <HomeStudioSelect value={form.home_location_id} locations={locations} onChange={(v) => setForm({ ...form, home_location_id: v })} />
      </Row>
      <Row label="Display phone">
        <input className={INPUT} value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} />
      </Row>
      <Row label="WABA ID">
        <input className={`${INPUT} font-mono`} value={form.business_account_id} onChange={(e) => setForm({ ...form, business_account_id: e.target.value.trim() })} />
      </Row>
      <Row label="App ID">
        <input className={`${INPUT} font-mono`} value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} />
      </Row>
      <Row
        label="Current token"
        hint={number.access_token_redacted
          ? 'A token is stored and never shown. To change it, paste a new token below.'
          : 'No token is saved yet. Paste one below to connect this number.'}
      >
        <p className="block w-full bg-un1t-surface/50 border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-muted">
          {number.access_token_redacted ? 'Saved (hidden)' : 'Not set'}
        </p>
      </Row>
      <Row label="New access token (leave blank to keep current)">
        <textarea rows={2} className={`${INPUT} font-mono`} value={form.new_access_token} onChange={(e) => setForm({ ...form, new_access_token: e.target.value })} />
      </Row>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        {ACTIVE_CHECKBOX_LABEL}
      </label>
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
    </div>
  )
}
