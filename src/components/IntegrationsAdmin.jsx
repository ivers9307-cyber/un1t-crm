'use client'

// /admin/integrations editor. Inline expand-to-edit per provider.
// Secrets are write-only after first save: we display a "set"
// indicator but never echo the stored value back to the form.

import { useState } from 'react'
import { ChevronDown, ChevronUp, Save, Loader2, CheckCircle2, XCircle } from 'lucide-react'

export default function IntegrationsAdmin({ initial }) {
  const [rows, setRows] = useState(initial)
  const [openId, setOpenId] = useState(null)
  const [error, setError] = useState(null)

  async function save(id, patch) {
    setError(null)
    const res = await fetch(`/api/admin/integrations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const json = await res.json()
    if (!json.ok) {
      setError(json.error || 'Save failed')
      return false
    }
    setRows((rs) => rs.map((r) => (r.id === id ? json.integration : r)))
    return true
  }

  return (
    <div>
      {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase text-un1t-light">
            <tr>
              <th className="px-4 py-2">Provider</th>
              <th className="px-4 py-2">Client ID</th>
              <th className="px-4 py-2">Secret</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} row={r} expanded={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} onSave={(p) => save(r.id, p)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row({ row, expanded, onToggle, onSave }) {
  const hasClientId = Boolean(row.client_id)
  const hasSecret   = Boolean(row.client_secret)
  return (
    <>
      <tr className="border-t border-neutral-200">
        <td className="px-4 py-3 font-medium">{row.display_name}</td>
        <td className="px-4 py-3">
          {hasClientId
            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={12} /> set</span>
            : <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><XCircle size={12} /> missing</span>}
        </td>
        <td className="px-4 py-3">
          {hasSecret
            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={12} /> set</span>
            : <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><XCircle size={12} /> missing</span>}
        </td>
        <td className="px-4 py-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            row.is_enabled
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-neutral-100 text-neutral-600'
          }`}>
            {row.is_enabled ? 'enabled' : 'disabled'}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded p-1.5 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Collapse' : 'Edit'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-neutral-200 bg-neutral-50">
          <td colSpan={5} className="px-4 py-4">
            <Editor row={row} onCancel={onToggle} onSave={onSave} />
          </td>
        </tr>
      )}
    </>
  )
}

function Editor({ row, onCancel, onSave }) {
  const [clientId, setClientId]    = useState(row.client_id || '')
  const [clientSecret, setSecret]  = useState('')
  const [redirectUri, setRedirect] = useState(row.redirect_uri || '')
  const [scopes, setScopes]        = useState((row.scopes || []).join(','))
  const [isEnabled, setEnabled]    = useState(Boolean(row.is_enabled))
  const [notes, setNotes]          = useState(row.notes || '')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    const patch = {
      client_id: clientId.trim(),
      redirect_uri: redirectUri.trim(),
      scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
      is_enabled: isEnabled,
      notes: notes,
    }
    // Only send client_secret if the user typed a new one.
    if (clientSecret.trim()) patch.client_secret = clientSecret.trim()
    const ok = await onSave(patch)
    setBusy(false)
    if (ok) onCancel()
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Client ID">
          <input className="ipt" type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="from the provider's developer portal" />
        </Field>
        <Field label="Client secret" hint={row.client_secret ? '(hidden — leave blank to keep)' : ''}>
          <input className="ipt" type="password" value={clientSecret} onChange={(e) => setSecret(e.target.value)} placeholder={row.client_secret ? '••••••••' : 'paste from provider'} />
        </Field>
        <Field label="Redirect URI" hint="set on the provider's app config">
          <input className="ipt" type="text" value={redirectUri} onChange={(e) => setRedirect(e.target.value)} placeholder="https://app.champfitness.ie/api/oauth/strava/callback" />
        </Field>
        <Field label="Scopes (comma-separated)">
          <input className="ipt" type="text" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="activity:write,read" />
        </Field>
      </div>
      <Field label="Notes (operator-only)">
        <textarea className="ipt" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3 pt-1">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isEnabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled — members can connect this provider
        </label>
        <button type="submit" disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>
      <style jsx>{`
        :global(.ipt) {
          width: 100%; padding: 0.4rem 0.6rem;
          border: 1px solid #d4d4d8; border-radius: 6px;
          background: white; font-size: 0.875rem;
        }
        :global(.ipt:focus) { outline: none; border-color: #71717a; box-shadow: 0 0 0 1px #71717a; }
      `}</style>
    </form>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs font-medium text-neutral-700">
        {label}
        {hint && <span className="ml-2 font-normal text-un1t-light">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
