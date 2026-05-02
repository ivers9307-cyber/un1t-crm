'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { validateAlphaSenderId } from '@/lib/twilio'

export default function LocationForm({ location, callerRole = 'owner' }) {
  const router = useRouter()
  const isEditing = !!location
  // UniFi controller config (host, token, policy IDs) is master-only
  // — mig 034 enforces this at the DB layer too. Owners managing
  // their own location never see or submit these fields.
  const canEditUnifi = callerRole === 'master'

  const [name, setName] = useState(location?.name || '')
  const [address, setAddress] = useState(location?.address || '')
  const [phone, setPhone] = useState(location?.phone || '')
  const [email, setEmail] = useState(location?.email || '')
  const [timezone, setTimezone] = useState(location?.timezone || 'Europe/Dublin')
  const [country, setCountry] = useState(location?.country || 'IE')
  const [active, setActive] = useState(location?.active !== false)

  // Twilio alpha sender ID (mig 059) — per-location branded sender
  // shown on recipients' phones. Empty string = use the global
  // TWILIO_FROM env fallback. Validation runs on save (max 11
  // alphanumeric chars per Twilio carrier rules).
  const [smsSenderId, setSmsSenderId] = useState(location?.twilio_alpha_sender_id || '')

  // Integration settings
  const settings = location?.settings || {}
  const [glofoxBranchId, setGlofoxBranchId] = useState(settings.glofox?.branch_id || '')
  const [glofoxApiKey, setGlofoxApiKey] = useState(settings.glofox?.api_key || '')

  // UniFi Access settings — drives the door-access toggle on staff profiles.
  // host  : public-facing URL of the UniFi Access controller, including
  //         port (12445 by default). Use Cloudflare Tunnel or similar so
  //         it's reachable from Vercel without port-forwarding the LAN.
  // token : Bearer API token created in Access > Settings > Advanced >
  //         API Token. Scopes: view:user, edit:user, view:policy.
  // staff_policy_id   : pre-created policy granting main door + physio.
  // manager_policy_id : pre-created policy granting all staff doors.
  const [unifiHost, setUnifiHost] = useState(settings.unifi?.host || '')
  const [unifiApiToken, setUnifiApiToken] = useState(settings.unifi?.api_token || '')
  const [unifiStaffPolicyId, setUnifiStaffPolicyId] = useState(settings.unifi?.staff_policy_id || '')
  const [unifiManagerPolicyId, setUnifiManagerPolicyId] = useState(settings.unifi?.manager_policy_id || '')
  const [unifiAllowSelfSigned, setUnifiAllowSelfSigned] = useState(settings.unifi?.allow_self_signed === true)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const db = createBrowserClient()
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

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
      // mig 059 — null = fall back to TWILIO_FROM env in the send path.
      twilio_alpha_sender_id: smsSenderId.trim() || null,
      settings: {
        ...(settings || {}),
        glofox: glofoxBranchId || glofoxApiKey ? {
          branch_id: glofoxBranchId || null,
          api_key: glofoxApiKey || null,
        } : null,
        // UniFi controller config is master-only (mig 034 enforces
        // at the DB layer). For non-masters, preserve whatever is
        // already on the row by passing the existing settings.unifi
        // object through unchanged — the trigger rejects ANY change
        // including writing a `null`.
        unifi: canEditUnifi
          ? ((unifiHost || unifiApiToken || unifiStaffPolicyId || unifiManagerPolicyId) ? {
              host: unifiHost || null,
              api_token: unifiApiToken || null,
              staff_policy_id: unifiStaffPolicyId || null,
              manager_policy_id: unifiManagerPolicyId || null,
              allow_self_signed: unifiAllowSelfSigned,
            } : null)
          : (settings.unifi || null),
      },
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

      {/* Glofox Integration */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Glofox Integration</h3>
        <p className="text-xs text-un1t-mid">Connect this location to its own Glofox branch for member syncing</p>

        <div>
          <label className="block text-sm mb-1.5">Branch ID</label>
          <input
            type="text"
            value={glofoxBranchId}
            onChange={e => setGlofoxBranchId(e.target.value)}
            placeholder="your-glofox-branch-id"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">API Key</label>
          <input
            type="password"
            value={glofoxApiKey}
            onChange={e => setGlofoxApiKey(e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
        </div>
      </div>

      {/* UniFi Access Integration — master only (mig 034). Owners
          configure who has door access via the per-staff toggles in
          Settings → Staff, but the controller credentials are
          platform infrastructure managed by master. */}
      {canEditUnifi && (
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">UniFi Access (Door Control)</h3>
        <p className="text-xs text-un1t-mid">
          Connect this studio&apos;s UniFi Access controller so the door-access toggle on staff profiles can grant or revoke
          building access. Pre-create two access policies in UniFi (one for staff, one for managers) and paste their IDs below.
        </p>

        <div>
          <label className="block text-sm mb-1.5">Controller Host</label>
          <input
            type="text"
            value={unifiHost}
            onChange={e => setUnifiHost(e.target.value)}
            placeholder="https://stillorgan-access.un1t.ie:12445"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-xs text-un1t-mid mt-1">
            Public URL where the UniFi Access API is reachable. Recommended: expose via Cloudflare Tunnel — no port forwarding required.
          </p>
        </div>

        <div>
          <label className="block text-sm mb-1.5">API Token</label>
          <input
            type="password"
            value={unifiApiToken}
            onChange={e => setUnifiApiToken(e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-xs text-un1t-mid mt-1">
            Create in UniFi: Access &gt; Settings &gt; Advanced &gt; API Token. Scopes: <span className="font-mono text-un1t-light">view:user, edit:user, view:policy</span>.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Staff Policy ID</label>
            <input
              type="text"
              value={unifiStaffPolicyId}
              onChange={e => setUnifiStaffPolicyId(e.target.value)}
              placeholder="03895c7f-9f53-4334-..."
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
            />
            <p className="text-xs text-un1t-mid mt-1">Main door + physio office</p>
          </div>
          <div>
            <label className="block text-sm mb-1.5">Manager Policy ID</label>
            <input
              type="text"
              value={unifiManagerPolicyId}
              onChange={e => setUnifiManagerPolicyId(e.target.value)}
              placeholder="3b6bcb0c-7498-44cf-..."
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
            />
            <p className="text-xs text-un1t-mid mt-1">+ main office (manager and above)</p>
          </div>
        </div>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={unifiAllowSelfSigned}
            onChange={e => setUnifiAllowSelfSigned(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs text-un1t-light">
            Allow self-signed certificate
            <span className="block text-un1t-mid">
              Only enable if the controller is reachable directly (not via Cloudflare Tunnel) and still uses its default UniFi cert.
            </span>
          </span>
        </label>
      </div>
      )}

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
