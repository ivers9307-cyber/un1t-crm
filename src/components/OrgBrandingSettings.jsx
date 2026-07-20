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
  // SAAS4-C2 — tenant legal identity for their hosted privacy notice.
  const [legalEntityName, setLegalEntityName] = useState('')
  const [legalTradingName, setLegalTradingName] = useState('')
  const [legalAddress, setLegalAddress] = useState('')
  const [privacyEmail, setPrivacyEmail] = useState('')
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
        if (active && data.success && data.data) {
          setCompanyName(data.data.company_name || '')
          setLegalEntityName(data.data.legal_entity_name || '')
          setLegalTradingName(data.data.legal_trading_name || '')
          setLegalAddress(data.data.legal_address || '')
          setPrivacyEmail(data.data.privacy_contact_email || '')
        }
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
        body: JSON.stringify({
          organization_id: orgId,
          company_name: companyName || null,
          legal_entity_name: legalEntityName.trim() || null,
          legal_trading_name: legalTradingName.trim() || null,
          legal_address: legalAddress.trim() || null,
          privacy_contact_email: privacyEmail.trim().toLowerCase() || null,
        }),
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

      {/* SAAS4-C2 — tenant legal identity for the privacy notice served on
          this org's own hostname. Entity name + privacy email must BOTH be
          set before the tenant-entity notice renders; until then the
          platform copy is served. Saved by the same Save button above. */}
      <div className="mt-4">
        <label className="block text-xs font-medium text-un1t-subtle mb-1.5">
          Legal identity (privacy notice)
        </label>
        <p className="text-xs text-un1t-muted mb-2">
          Shown as the data controller on the privacy policy at this organisation&rsquo;s own domain.
          The notice only switches from the platform default once the registered name AND privacy
          email are both set.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={legalEntityName}
            onChange={e => setLegalEntityName(e.target.value)}
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="Registered company name (e.g. FitCo Ltd)"
          />
          <input
            type="text"
            value={legalTradingName}
            onChange={e => setLegalTradingName(e.target.value)}
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="Trading name (optional)"
          />
          <input
            type="text"
            value={legalAddress}
            onChange={e => setLegalAddress(e.target.value)}
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="Registered address (optional)"
          />
          <input
            type="email"
            value={privacyEmail}
            onChange={e => setPrivacyEmail(e.target.value)}
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="privacy@yourgym.ie"
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
