'use client'

import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'

// Organisation-level branding default (mig 317). The company name set here is
// inherited by every location in the org that has not set its own (see
// getLocationBranding). Logo/favicon inheritance is supported by the resolver
// and API, but uploaded per-location for now. Owner-of-org or master only —
// the PUT route is the authority; a non-owner simply gets a 403 on save.
export default function OrgBrandingSettings({ orgId, orgName }) {
  const [companyName, setCompanyName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const res = await fetch(`/api/settings/org-branding?organization_id=${orgId}`)
        const data = await res.json()
        if (active && data.success && data.data) setCompanyName(data.data.company_name || '')
      } catch { /* leave blank — the field defaults to the UN1T fallback */ }
      if (active) setLoading(false)
    }
    if (orgId) load()
    else setLoading(false)
    return () => { active = false }
  }, [orgId])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/org-branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: orgId, company_name: companyName || null }),
      })
      const data = await res.json()
      if (data.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(data.error || 'Could not save')
      }
    } catch {
      setError('Could not save')
    }
    setSaving(false)
  }

  if (loading) return <div className="text-sm text-un1t-subtle py-2">Loading organisation defaults...</div>

  return (
    <div className="mb-6 pb-6 border-b border-un1t-border">
      <label className="block text-xs font-medium text-un1t-subtle mb-1.5">
        Organisation default name{orgName ? ` — ${orgName}` : ''}
      </label>
      <p className="text-xs text-un1t-muted mb-2">
        Inherited by every location in this organisation that has not set its own name below. Used in customer messages (WhatsApp, Mia, win-backs).
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={companyName}
          onChange={e => setCompanyName(e.target.value)}
          className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          placeholder="UN1T"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-un1t-text text-un1t-bg text-xs font-medium rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {saved ? <><Check size={12} /> Saved</> : saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
