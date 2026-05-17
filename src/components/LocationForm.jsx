'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { validateAlphaSenderId } from '@/lib/twilio'

export default function LocationForm({ location, callerRole = 'owner', organizations = [] }) {
  const router = useRouter()
  const isEditing = !!location
  // SETTINGS.1 — Integration configs (UniFi, Sensibo, Glofox) used
  // to live in this form. They moved into <LocationIntegrations>
  // tabs on the same page; callerRole is no longer read here.
  // mig 034's DB-side trigger remains the security backstop for any
  // settings.unifi write made from those tabs.
  void callerRole

  const [name, setName] = useState(location?.name || '')
  const [address, setAddress] = useState(location?.address || '')
  const [phone, setPhone] = useState(location?.phone || '')
  const [email, setEmail] = useState(location?.email || '')
  const [timezone, setTimezone] = useState(location?.timezone || 'Europe/Dublin')
  const [country, setCountry] = useState(location?.country || 'IE')
  const [active, setActive] = useState(location?.active !== false)
  // Organization (mig 079) — required for new locations. Shown read-only
  // when editing because moving a location between orgs is rare and
  // risky (would change RLS visibility for every member at the
  // destination org). If a real cross-org move is needed, do it via
  // SQL with intent.
  const [organizationId, setOrganizationId] = useState(
    location?.organization_id || (organizations[0]?.id ?? '')
  )

  // Twilio alpha sender ID (mig 059) — per-location branded sender
  // shown on recipients' phones. Empty string = use the global
  // TWILIO_FROM env fallback. Validation runs on save (max 11
  // alphanumeric chars per Twilio carrier rules).
  const [smsSenderId, setSmsSenderId] = useState(location?.twilio_alpha_sender_id || '')

  // Roster v2 phase 4 — monthly contractor labour budget (mig 071).
  // Stored as numeric euros; null = not configured. FTE labour
  // is NOT counted against this — only contractor hours × rate.
  const [contractorBudget, setContractorBudget] = useState(
    location?.monthly_contractor_budget_eur != null ? String(location.monthly_contractor_budget_eur) : ''
  )

  // SETTINGS.1 — Glofox / UniFi / Sensibo / AC are now their own
  // tabs under <LocationIntegrations> below this form. Their state
  // + save logic lives in the per-tab components; LocationForm
  // covers only the per-location identity + Twilio + budget fields.

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const db = createBrowserClient()
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

    // mig 079 — every location must belong to an organization. The
    // dropdown is required for new locations; for edits it's read-only
    // and we fall back to the existing value.
    if (!isEditing && !organizationId) {
      setError('Pick an organization for this location.')
      setSaving(false)
      return
    }

    // Validate the SMS sender ID app-side before sending. Twilio
    // rejects non-conforming alpha sender IDs at send time, but
    // catching it here gives a clean inline error instead of a
    // delivery failure later.
    if (smsSenderId) {
      const senderError = validateAlphaSenderId(smsSenderId)
      if (senderError) {
        setError(`SMS sender ID: ${senderError}`)
        setSaving(false)
        return
      }
    }

    const payload = {
      name,
      slug,
      address: address || null,
      phone: phone || null,
      email: email || null,
      timezone,
      country,
      active,
      // mig 079 — every location belongs to an organization. For edits
      // we preserve the existing org (read-only in the UI); for creates
      // we use the picker value (required, validated above).
      organization_id: isEditing ? location.organization_id : organizationId,
      // mig 059 — null = fall back to TWILIO_FROM env in the send path.
      twilio_alpha_sender_id: smsSenderId.trim() || null,
      // mig 071 — null = not configured (summary panel shows total
      // spend without an over/under chip). 0 IS valid and means
      // "no contractor labour allowed", which the panel will treat
      // as "always over budget".
      monthly_contractor_budget_eur: contractorBudget.trim() === ''
        ? null
        : (Number.isFinite(Number(contractorBudget)) ? Number(contractorBudget) : null),
      // SETTINGS.1 — sensibo_api_key / sensibo_pod_id / ac_default_*,
      // settings.glofox, and settings.unifi are deliberately NOT
      // included in this payload. Postgres leaves untouched columns
      // alone, so the per-tab Integrations save endpoints own those
      // slices independently. Don't add them back here.
      updated_at: new Date().toISOString(),
    }

    let result
    if (isEditing) {
      result = await db.from('locations').update(payload).eq('id', location.id).select().single()
    } else {
      result = await db.from('locations').insert(payload).select().single()
    }

    if (result.error) {
      setError(result.error.message)
      setSaving(false)
      return
    }

    // Seed default pipeline stages for new locations
    if (!isEditing && result.data?.id) {
      const defaultStages = [
        { name: 'New Lead',           slug: 'new_lead',          display_order: 1, color: '#3B82F6' },
        { name: 'New Lead — Social',  slug: 'new_lead_social',   display_order: 2, color: '#8B5CF6' },
        { name: 'Trial Active',       slug: 'trial_active',      display_order: 3, color: '#10B981' },
        { name: 'Conversion Ready',   slug: 'conversion_ready',  display_order: 4, color: '#F59E0B' },
        { name: 'Follow-up Needed',   slug: 'follow_up_needed',  display_order: 5, color: '#EF4444' },
        { name: 'Member',             slug: 'member',            display_order: 6, color: '#059669' },
        { name: 'Cold — Email Only',  slug: 'cold_email_only',   display_order: 7, color: '#9CA3AF' },
        { name: 'Lost Member',        slug: 'lost_member',       display_order: 8, color: '#DC2626' },
        { name: 'Returning Member',   slug: 'returning_member',  display_order: 9, color: '#6366F1' },
      ].map(s => ({ ...s, location_id: result.data.id }))

      await db.from('pipeline_stages').insert(defaultStages)
    }

    router.push('/settings')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Location Details</h3>

        {/* Organization picker (mig 079). Required when creating; read-only when editing. */}
        {organizations.length > 0 && (
          <div>
            <label className="block text-sm mb-1.5">Organization *</label>
            {isEditing ? (
              <div className="w-full bg-un1t-black/60 border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-light">
                {organizations.find(o => o.id === location?.organization_id)?.name || '—'}
                <span className="ml-2 text-[11px] text-un1t-mid">(read-only — moving locations between orgs is rare; do via SQL with intent)</span>
              </div>
            ) : (
              <select
                required
                value={organizationId}
                onChange={e => setOrganizationId(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              >
                <option value="">Pick an organization…</option>
                {organizations.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm mb-1.5">Name *</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="UN1T Dublin City"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="123 Example St, Dublin 2"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Phone</label>
            <input
              type="text"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+353 1 234 5678"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="info@un1t.ie"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Country</label>
            <select
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="IE">Ireland (IE)</option>
              <option value="GB">United Kingdom (GB)</option>
              <option value="DE">Germany (DE)</option>
              <option value="AU">Australia (AU)</option>
              <option value="KW">Kuwait (KW)</option>
              <option value="MT">Malta (MT)</option>
              <option value="EG">Egypt (EG)</option>
              <option value="CY">Cyprus (CY)</option>
            </select>
            <p className="text-xs text-un1t-mid mt-1">Drives the public-holiday list on the schedule. All listed countries have built-in holidays through 2030.</p>
          </div>
          <div>
            <label className="block text-sm mb-1.5">Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="Europe/Dublin">Europe/Dublin</option>
              <option value="Europe/London">Europe/London</option>
              <option value="Europe/Berlin">Europe/Berlin</option>
              <option value="Europe/Malta">Europe/Malta</option>
              <option value="Asia/Nicosia">Asia/Nicosia (Cyprus)</option>
              <option value="Africa/Cairo">Africa/Cairo</option>
              <option value="Asia/Kuwait">Asia/Kuwait</option>
              <option value="Australia/Sydney">Australia/Sydney</option>
              <option value="Australia/Melbourne">Australia/Melbourne</option>
              <option value="Australia/Brisbane">Australia/Brisbane</option>
              <option value="Australia/Perth">Australia/Perth</option>
              <option value="Australia/Adelaide">Australia/Adelaide</option>
            </select>
          </div>
        </div>

        {isEditing && (
          <div>
            <label className="block text-sm mb-1.5">Status</label>
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {active ? 'Active' : 'Inactive'}
            </button>
          </div>
        )}
      </div>

      {/* SMS (Twilio) — per-location alpha sender ID (mig 059). The
          actual Twilio account credentials live in env vars (one
          account, multiple branded sender IDs). The sender ID set
          here is what shows on recipients' phones at this location. */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">SMS (Twilio)</h3>
        <p className="text-xs text-un1t-mid">
          Branded sender ID shown on recipients' phones for SMS sent from this location.
          Leave blank to use the global default.
        </p>

        <div>
          <label className="block text-sm mb-1.5">Alpha Sender ID</label>
          <input
            type="text"
            value={smsSenderId}
            onChange={e => setSmsSenderId(e.target.value)}
            placeholder="e.g. UN1T or UN1THATCH"
            maxLength={11}
            pattern="[A-Za-z0-9]*"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-[11px] text-un1t-mid mt-1">
            Max 11 chars, alphanumeric only (no spaces or punctuation).
            Some carriers require pre-registration of branded sender IDs — check Twilio's regional guidelines for IE/UK before going live.
          </p>
        </div>
      </div>

      {/* Roster v2 phase 4 — Monthly contractor labour budget (mig 071).
          FTE labour is sunk cost and doesn't count; this ceiling
          tracks contractor hours × hourly_rate for the month. */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Coaching Budget</h3>
        <p className="text-xs text-un1t-mid">
          Monthly euro ceiling for <strong>contractor</strong> labour at this location. FTE coaches are sunk cost and don&apos;t count against this. Leave blank if you don&apos;t want to track a budget — the schedule summary will still show the spend total.
        </p>

        <div>
          <label className="block text-sm mb-1.5">Monthly contractor budget (€)</label>
          <input
            type="number"
            min={0}
            step={50}
            value={contractorBudget}
            onChange={e => setContractorBudget(e.target.value)}
            placeholder="e.g. 2500"
            className="w-48 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
          />
          <p className="text-[11px] text-un1t-mid mt-1">
            Phase 5 will add an owner-approval gate when a published roster exceeds this budget. Right now the summary panel below the schedule is read-only / advisory.
          </p>
        </div>
      </div>


      {/* Submit */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-un1t-white text-un1t-black text-sm font-medium px-5 py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEditing ? 'Update Location' : 'Create Location'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/settings')}
          className="text-sm text-un1t-light hover:text-un1t-white transition-colors px-4 py-2.5"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

