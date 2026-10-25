'use client'

// UniFi Access integration tab. Extracted from LocationForm as part
// of SETTINGS.1. Master-only (the route's role gate; mig 034's DB-side
// trigger also rejects browser writes to settings.unifi from non-masters).
//
// SECFIX.3b — saves through the masked, service-role PUT
// /api/locations/[id]/integrations/unifi (write-only token: a blank field
// keeps the stored value; the registry re-syncs in-handler). It never reads
// or writes locations from the browser.
//
// Drives the door-access toggle on staff profiles and the live
// unlock button in /studio-management (which calls UniFi's
// /doors/<id>/remote_unlock).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Save, Loader2, Check, AlertCircle } from 'lucide-react'

export default function UnifiIntegrationTab({ location, canEdit }) {
  const router = useRouter()
  const initial = location.settings?.unifi || {}

  const [host, setHost] = useState(initial.host || '')
  // SECFIX.3b — masked on the page; the input starts blank (write-only).
  const [savedToken, setSavedToken] = useState(!!initial.api_token)
  const [apiToken, setApiToken] = useState('')
  const [staffPolicyId, setStaffPolicyId] = useState(initial.staff_policy_id || '')
  const [managerPolicyId, setManagerPolicyId] = useState(initial.manager_policy_id || '')
  const [allowSelfSigned, setAllowSelfSigned] = useState(initial.allow_self_signed === true)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    const body = {
      host,
      staff_policy_id: staffPolicyId,
      manager_policy_id: managerPolicyId,
      allow_self_signed: allowSelfSigned,
      ...(apiToken.trim() ? { api_token: apiToken.trim() } : {}),
    }
    let res
    let json = null
    try {
      res = await fetch(`/api/locations/${location.id}/integrations/unifi`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      json = await res.json().catch(() => null)
    } catch (e) {
      setSaving(false)
      setError(`Could not save: ${e?.message || 'network error'}`)
      return
    }
    setSaving(false)
    if (!res.ok || !json?.success) { setError(json?.error || `Save failed (${res.status})`); return }
    setSavedToken(!!json.data?.has_token)
    setApiToken('')
    setSavedAt(new Date())
    router.refresh()
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-subtle">
        UniFi controller settings are master-only.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Controller host should be reachable from Vercel (Cloudflare Tunnel works well —
        port-forwarding the LAN does not). API token needs scopes <code className="text-[10px] mx-1 px-1 bg-un1t-bg/40 rounded">view:user</code>,
        <code className="text-[10px] mx-1 px-1 bg-un1t-bg/40 rounded">edit:user</code>,
        <code className="text-[10px] mx-1 px-1 bg-un1t-bg/40 rounded">view:policy</code>.
        The two policy IDs must be pre-created in UniFi Access — staff = main door + physio, manager = all staff doors.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-2 inline-flex items-center gap-2">
          <Check size={12} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <Field label="Host" htmlFor="unifi-host" hint="Public-facing URL, include port (default 12445), e.g. https://unifi.example.com:12445">
        <input id="unifi-host" type="text" value={host} onChange={e => setHost(e.target.value)}
          placeholder="https://unifi.example.com:12445"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>
      <Field label="API Token" htmlFor="unifi-api-token">
        <input id="unifi-api-token" type="password" autoComplete="new-password" aria-describedby="unifi-api-token-status" value={apiToken} onChange={e => setApiToken(e.target.value)}
          placeholder={savedToken ? 'Saved (hidden). Type to replace.' : ''}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
        <p id="unifi-api-token-status" className="text-[11px] text-un1t-muted mt-1">
          {savedToken ? 'Currently set. Leave blank to keep it, or enter a new value to replace it.' : 'Not set yet.'}
        </p>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Staff policy ID" htmlFor="unifi-staff-policy">
          <input id="unifi-staff-policy" type="text" value={staffPolicyId} onChange={e => setStaffPolicyId(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
        </Field>
        <Field label="Manager policy ID" htmlFor="unifi-manager-policy">
          <input id="unifi-manager-policy" type="text" value={managerPolicyId} onChange={e => setManagerPolicyId(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
        </Field>
      </div>

      <div className="flex items-center justify-between border border-un1t-border rounded-md px-3 py-2">
        <div>
          <div className="text-sm text-un1t-text">Allow self-signed certs</div>
          <div className="text-[11px] text-un1t-muted">Only flip on for dev / LAN. Production should use a trusted cert.</div>
        </div>
        <button
          type="button"
          onClick={() => setAllowSelfSigned(v => !v)}
          className={`w-10 h-5 rounded-full transition-colors ${allowSelfSigned ? 'bg-green-500' : 'bg-un1t-border'}`}
        >
          <div className={`w-4 h-4 rounded-full bg-white transition-transform ${allowSelfSigned ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="flex justify-end pt-2 border-t border-un1t-border/40">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving
            ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
            : <><Save size={12} /> Save</>
          }
        </button>
      </div>
    </div>
  )
}

function Field({ label, hint, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
    </div>
  )
}
