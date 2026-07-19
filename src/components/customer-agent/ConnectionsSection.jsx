'use client'

import { useState, useEffect, useCallback } from 'react'

// RADAR-AGENT.0b / IG-HOME.1 — per-location channel connections.
// Home is now the per-location Integrations tab strip (Settings →
// Locations → <name> → Integrations → Instagram), rendered with
// `embedded` so only the Instagram card shows. The full standalone
// section (heading + WhatsApp pointer card) remains for any other
// callers. Secrets come back masked from the API and are only
// overwritten when re-typed; docs/instagram-setup.md is the runbook.

const IG_FIELDS = [
  { key: 'display_name', label: 'Instagram handle / name', placeholder: '@un1t_stillorgan', secret: false, full: true },
  { key: 'external_account_id', label: 'Instagram professional account ID', placeholder: '17841...', secret: false },
  { key: 'app_id', label: 'Instagram app ID', placeholder: '2691...', secret: false },
  { key: 'page_id', label: 'Facebook Page ID (not used by Instagram Login — leave blank)', placeholder: '', secret: false },
  { key: 'access_token', label: 'Instagram access token (from the app dashboard / business login)', placeholder: 'IGAA...', secret: true },
  { key: 'app_secret', label: 'Instagram app secret (also set as INSTAGRAM_APP_SECRET env)', placeholder: 'paste to set', secret: true },
]

export default function ConnectionsSection({ locationId, locationName, embedded = false }) {
  const [connections, setConnections] = useState([])
  const [draft, setDraft] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/locations/${locationId}/channels`).then(r => r.json())
      if (res.success) {
        setConnections(res.connections || [])
        const ig = (res.connections || []).find(c => c.platform === 'instagram')
        setDraft(ig ? { ...ig } : {})
      }
    } catch { setError('Failed to load connections') }
    finally { setLoading(false) }
  }, [locationId])

  useEffect(() => { load() }, [load])

  const igConn = connections.find(c => c.platform === 'instagram')

  function setField(k, v) { setDraft(d => ({ ...d, [k]: v })) }

  async function saveInstagram() {
    setSaving(true); setError(null)
    try {
      const payload = { platform: 'instagram', is_active: true }
      for (const f of IG_FIELDS) {
        const v = draft[f.key]
        if (f.secret) {
          if (v && !String(v).startsWith('••')) payload[f.key] = v
        } else if (v !== undefined) {
          payload[f.key] = v
        }
      }
      payload.agent_enabled = !!draft.agent_enabled
      const url = igConn
        ? `/api/locations/${locationId}/channels/${igConn.id}`
        : `/api/locations/${locationId}/channels`
      const method = igConn ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.success) { setSavedAt(Date.now()); await load() }
      else setError(j.error || 'Failed to save')
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  async function disconnectInstagram() {
    if (!igConn) return
    await fetch(`/api/locations/${locationId}/channels/${igConn.id}`, { method: 'DELETE' })
    await load()
  }

  if (loading) return <div className="text-sm text-un1t-muted">Loading connections…</div>

  const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
  const igLive = !!(igConn && igConn.has_access_token)

  const instagramCard = (
    <div className="border border-un1t-border rounded-md px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-un1t-text">
            Instagram
            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${igLive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
              {igLive ? 'Connected' : 'Not connected'}
            </span>
          </div>
          {igConn && (
            <button onClick={disconnectInstagram} className="text-xs text-red-600 hover:underline">Disconnect</button>
          )}
        </div>

        <p className="text-xs text-un1t-muted mb-3">
          Connect this studio&apos;s Instagram via the Instagram Login API: add the account under the
          Instagram app&apos;s API setup page and paste its token here (docs/instagram-setup.md has the
          full runbook). Tokens refresh automatically each week. (A one-click business login can be
          added later — for now these are entered manually.)
        </p>

        <div className="grid sm:grid-cols-2 gap-3">
          {IG_FIELDS.map(f => (
            <div key={f.key} className={f.full ? 'sm:col-span-2' : ''}>
              <label className="block text-xs text-un1t-muted mb-1">{f.label}</label>
              <input
                className={inputCls}
                type={f.secret ? 'password' : 'text'}
                value={draft[f.key] || ''}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                autoComplete="off"
              />
            </div>
          ))}
        </div>

        <label className="flex items-center gap-2 mt-4 cursor-pointer">
          <input
            type="checkbox"
            checked={!!draft.agent_enabled}
            onChange={e => setField('agent_enabled', e.target.checked)}
          />
          <span className="text-sm text-un1t-text">Mia auto-replies on Instagram</span>
        </label>
        <p className="text-xs text-un1t-muted mt-1">
          Off by default. Inbound DMs still land in the inbox and notify staff — Mia only answers when this is on.
        </p>

        {error && <div className="text-sm text-red-600 mt-3">{error}</div>}
        <div className="mt-4">
          <button onClick={saveInstagram} disabled={saving}
            className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : igConn ? 'Update Instagram' : 'Connect Instagram'}
          </button>
          {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
        </div>
    </div>
  )

  if (embedded) return instagramCard

  return (
    <section className="border border-un1t-border rounded-lg p-5 mb-6">
      <h2 className="text-base font-semibold text-un1t-text mb-1">Connections</h2>
      <p className="text-sm text-un1t-muted mb-4">
        The channels this studio&apos;s agent answers on{locationName ? ` — ${locationName}` : ''}. Each location
        connects its own accounts.
      </p>

      {/* WhatsApp — managed under Integrations */}
      <div className="flex items-center justify-between border border-un1t-border rounded-md px-4 py-3 mb-4">
        <div>
          <div className="text-sm font-medium text-un1t-text">WhatsApp</div>
          <div className="text-xs text-un1t-muted">Managed under Settings → Integrations → WhatsApp numbers.</div>
        </div>
        <a href="/settings/integrations" className="text-xs text-un1t-text underline">Manage</a>
      </div>

      {instagramCard}
    </section>
  )
}
