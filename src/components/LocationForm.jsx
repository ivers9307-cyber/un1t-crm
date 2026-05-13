'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { validateAlphaSenderId } from '@/lib/twilio'

export default function LocationForm({ location, callerRole = 'owner', organizations = [] }) {
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

  // Integration settings
  const settings = location?.settings || {}
  const [glofoxBranchId, setGlofoxBranchId] = useState(settings.glofox?.branch_id || '')
  const [glofoxApiKey, setGlofoxApiKey] = useState(settings.glofox?.api_key || '')
  // GLOFOX1.6 — Glofox auth requires THREE headers (branch-id +
  // api-key + api-token). Webhook signature verification (HMAC-
  // SHA256) needs a separate secret Glofox provides when
  // webhooks are enabled. Both stored alongside the existing
  // branch_id + api_key in settings.glofox so all Glofox config
  // for a location lives in one place.
  const [glofoxApiToken, setGlofoxApiToken] = useState(settings.glofox?.api_token || '')
  const [glofoxWebhookSecret, setGlofoxWebhookSecret] = useState(settings.glofox?.webhook_secret || '')
  // PIPELINE5.10 — namespace is required by /Analytics/report (and a
  // few v3 endpoints). Glofox returns 200-but-empty when it's
  // missing, which masked the bug for ages until 5.5f. Visible to
  // operators here so future locations don't repeat the manual SQL
  // backfill we ran for Stillorgan.
  const [glofoxNamespace, setGlofoxNamespace] = useState(settings.glofox?.namespace || '')
  // GLOFOX3.1 — trial membership config. Picked from a dropdown
  // backed by /api/locations/[id]/glofox-memberships. Used when
  // we create a fresh Glofox account for a CRM contact (booking
  // form opt-in / event opt-in / manual button) — the trial
  // membership gets attached automatically via Glofox's purchase
  // endpoint. Stored as a "membershipId:planCode" combined value
  // so the picker can render both axes in one dropdown.
  const [glofoxTrialMembershipId, setGlofoxTrialMembershipId] = useState(settings.glofox?.trial_membership_id || '')
  const [glofoxTrialPlanCode, setGlofoxTrialPlanCode] = useState(settings.glofox?.trial_plan_code || '')

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

  // Sensibo / AC config (mig 103). Top-level columns on locations,
  // not in settings JSONB. Master + owner can edit.
  const [sensiboApiKey, setSensiboApiKey] = useState(location?.sensibo_api_key || '')
  const [sensiboPodId, setSensiboPodId] = useState(location?.sensibo_pod_id || '')
  const [acDefaultMode, setAcDefaultMode] = useState(location?.ac_default_mode || 'cool')
  const [acDefaultTemp, setAcDefaultTemp] = useState(location?.ac_default_temp ?? 18)
  const [acDefaultFan, setAcDefaultFan] = useState(location?.ac_default_fan || 'high')
  const [acSessionMinutes, setAcSessionMinutes] = useState(location?.ac_session_minutes ?? 90)
  const [pods, setPods] = useState(null)
  const [podsLoading, setPodsLoading] = useState(false)
  const [podsError, setPodsError] = useState(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function loadPods() {
    if (!sensiboApiKey.trim()) {
      setPodsError('Paste an API key first.')
      return
    }
    setPodsLoading(true)
    setPodsError(null)
    try {
      const url = `/api/studio-management/ac/pods?api_key=${encodeURIComponent(sensiboApiKey.trim())}`
      const r = await fetch(url, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Failed (${r.status})`)
      setPods(j.data || [])
    } catch (e) {
      setPodsError(e.message || 'Failed to fetch pods')
      setPods([])
    } finally {
      setPodsLoading(false)
    }
  }

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
      // Sensibo / AC config (mig 103). Top-level columns; master/owner only.
      ...(canEditUnifi ? {
        sensibo_api_key: sensiboApiKey.trim() || null,
        sensibo_pod_id: sensiboPodId.trim() || null,
        ac_default_mode: acDefaultMode || 'cool',
        ac_default_temp: Number(acDefaultTemp) || 18,
        ac_default_fan: acDefaultFan || 'high',
        ac_session_minutes: Number(acSessionMinutes) || 90,
      } : {}),
      settings: {
        ...(settings || {}),
        glofox: (glofoxBranchId || glofoxApiKey || glofoxApiToken || glofoxWebhookSecret || glofoxNamespace || glofoxTrialMembershipId) ? {
          branch_id: glofoxBranchId || null,
          api_key: glofoxApiKey || null,
          namespace: glofoxNamespace || null,
          trial_membership_id: glofoxTrialMembershipId || null,
          trial_plan_code: glofoxTrialPlanCode || null,
          // GLOFOX1.6 — api_token is the third header Glofox auth
          // requires alongside branch_id + api_key. webhook_secret
          // is the HMAC-SHA256 signing secret Glofox provides
          // separately when webhooks are enabled.
          api_token: glofoxApiToken || null,
          webhook_secret: glofoxWebhookSecret || null,
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

      {/* Glofox Integration */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Glofox Integration</h3>
        <p className="text-xs text-un1t-mid">
          Connect this location to its own Glofox branch for member syncing + inbound webhooks. All four values
          come from <a href="mailto:apiactivation@abcfitness.com" className="underline hover:text-un1t-light">apiactivation@abcfitness.com</a> when they enable
          your integration. Test the connection at <code>/api/glofox/ping?location_id={location?.id || '<this-location-id>'}</code>.
        </p>

        <div>
          <label className="block text-sm mb-1.5">Branch ID</label>
          <input
            type="text"
            value={glofoxBranchId}
            onChange={e => setGlofoxBranchId(e.target.value)}
            placeholder="your-glofox-branch-id"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-[11px] text-un1t-mid mt-1">Sent as the <code>x-glofox-branch-id</code> header. Identifies this location to Glofox.</p>
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
          <p className="text-[11px] text-un1t-mid mt-1">Sent as the <code>x-api-key</code> header.</p>
        </div>

        <div>
          <label className="block text-sm mb-1.5">API Token</label>
          <input
            type="password"
            value={glofoxApiToken}
            onChange={e => setGlofoxApiToken(e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-[11px] text-un1t-mid mt-1">Sent as the <code>x-glofox-api-token</code> header. Different from the API Key — Glofox issues both.</p>
        </div>

        <div>
          <label className="block text-sm mb-1.5">Namespace</label>
          <input
            type="text"
            value={glofoxNamespace}
            onChange={e => setGlofoxNamespace(e.target.value)}
            placeholder="e.g. untstillorgan"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-[11px] text-un1t-mid mt-1">
            Studio namespace as it appears in Glofox URLs and webhook payloads (e.g.{' '}
            <code>untstillorgan</code>). Required by <code>/Analytics/report</code> for the invoice backfill —
            without it the endpoint returns 200 with an empty result and no error. You can find it in any
            recent webhook payload at <code>Payload.namespace</code>, or in your Glofox studio URL.
          </p>
        </div>

        <div>
          <label className="block text-sm mb-1.5">Webhook Secret</label>
          <input
            type="password"
            value={glofoxWebhookSecret}
            onChange={e => setGlofoxWebhookSecret(e.target.value)}
            placeholder="hex-string-from-glofox-when-webhooks-enabled"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-[11px] text-un1t-mid mt-1">HMAC-SHA256 signing secret. Glofox sends this separately when they enable webhooks; until then leave blank and the receiver will reject all events for safety.</p>
        </div>

        {/* GLOFOX3.1 — trial membership picker. Required for the
            CRM → Glofox push flows (booking forms, events, manual
            "Create in Glofox" button) to attach a trial product
            to freshly-created Glofox accounts. Lazy-fetches the
            membership catalog from /2.0/memberships when the
            picker is opened. */}
        <GlofoxTrialMembershipPicker
          locationId={location?.id}
          configured={Boolean(glofoxBranchId && glofoxApiKey && glofoxApiToken)}
          membershipId={glofoxTrialMembershipId}
          planCode={glofoxTrialPlanCode}
          onChange={(m, p) => {
            setGlofoxTrialMembershipId(m || '')
            setGlofoxTrialPlanCode(p || '')
          }}
        />
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

      {/* AC / Sensibo Integration — master + owner only.
          Drives the Studio Management → AC turn-on button. */}
      {canEditUnifi && (
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Air Conditioning (Sensibo)</h3>
        <p className="text-xs text-un1t-mid">
          Connect this studio&apos;s Sensibo account so staff can turn the AC on from the Studio Management page.
          One-button toggle applies the preset below; auto-off after the session duration.
          {' '}<a href="https://home.sensibo.com/me/api" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Get an API key →</a>
        </p>

        <div>
          <label className="block text-sm mb-1.5">Sensibo API key</label>
          <input
            type="password"
            value={sensiboApiKey}
            onChange={e => setSensiboApiKey(e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
          <p className="text-xs text-un1t-mid mt-1">
            From <span className="font-mono">home.sensibo.com → Account → API</span>. Plaintext is fine — controls AC only.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm">Pod (AC unit)</label>
            <button
              type="button"
              onClick={loadPods}
              disabled={podsLoading || !sensiboApiKey.trim()}
              className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40"
            >
              {podsLoading ? 'Loading…' : 'List pods on this account'}
            </button>
          </div>
          {pods && pods.length > 0 ? (
            <select
              value={sensiboPodId}
              onChange={e => setSensiboPodId(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="">Choose…</option>
              {pods.map(p => (
                <option key={p.id} value={p.id}>
                  {p.room_name || p.id} {p.product_model ? `(${p.product_model})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={sensiboPodId}
              onChange={e => setSensiboPodId(e.target.value)}
              placeholder="paste pod id, or click 'List pods' above"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
            />
          )}
          {podsError && (
            <p className="text-xs text-red-300 mt-1">{podsError}</p>
          )}
          {pods && pods.length === 0 && !podsError && (
            <p className="text-xs text-amber-300 mt-1">No pods on this account.</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm mb-1.5">Mode</label>
            <select
              value={acDefaultMode}
              onChange={e => setAcDefaultMode(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="cool">Cool</option>
              <option value="heat">Heat</option>
              <option value="auto">Auto</option>
              <option value="fan">Fan only</option>
              <option value="dry">Dry</option>
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1.5">Target (°C)</label>
            <input
              type="number"
              min="16"
              max="30"
              value={acDefaultTemp}
              onChange={e => setAcDefaultTemp(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Fan</label>
            <select
              value={acDefaultFan}
              onChange={e => setAcDefaultFan(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="quiet">Quiet</option>
              <option value="strong">Strong</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm mb-1.5">Auto-off after (minutes)</label>
          <input
            type="number"
            min="5"
            max="720"
            value={acSessionMinutes}
            onChange={e => setAcSessionMinutes(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          />
          <p className="text-xs text-un1t-mid mt-1">
            How long the AC stays on after the staff button is pressed before the cron auto-shuts it. Default 90.
          </p>
        </div>
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

// GLOFOX3.1 — trial-membership picker. Lazy-fetches the catalog
// from /api/locations/[id]/glofox-memberships when expanded so we
// don't hit Glofox on every LocationForm mount. Disabled until
// branch_id + api_key + api_token are all set on the same form
// (otherwise the API call would 400).
function GlofoxTrialMembershipPicker({ locationId, configured, membershipId, planCode, onChange }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [memberships, setMemberships] = useState(null)

  const currentLabel = (() => {
    if (!membershipId) return 'No trial membership configured'
    if (!memberships) {
      // Show truncated id until the catalog loads.
      return `Membership ${membershipId.slice(0, 8)}… · plan ${planCode || '?'}`
    }
    const m = memberships.find(x => x._id === membershipId)
    if (!m) return `Membership ${membershipId.slice(0, 8)}… (not in catalog?)`
    const p = m.plans.find(x => x.code === planCode)
    return `${m.name}${p ? ` · ${p.name || p.code} (€${p.price})` : ''}`
  })()

  async function fetchMemberships() {
    if (loading || !locationId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/glofox-memberships`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.message || json.error || 'Fetch failed')
      setMemberships(json.memberships || [])
    } catch (e) {
      setError(e.message || 'Could not load Glofox memberships')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && memberships === null && configured) fetchMemberships()
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-sm mb-1.5">Trial membership for new Glofox accounts</label>
      <button
        type="button"
        onClick={handleToggle}
        disabled={!locationId}
        className="w-full flex items-center justify-between text-left rounded-md border border-un1t-gray bg-un1t-black px-3 py-2 text-sm hover:border-un1t-mid disabled:opacity-50"
      >
        <span className="truncate">{currentLabel}</span>
        <span className="text-un1t-light text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>
      {!configured && (
        <p className="text-[11px] text-amber-300/80">
          Save the Glofox host + branch_id + api_key + api_token first, then come back here to pick a trial membership.
        </p>
      )}
      {open && configured && (
        <div className="rounded-md border border-un1t-gray bg-un1t-black p-2 space-y-1 max-h-80 overflow-y-auto">
          {loading && <div className="text-xs text-un1t-light px-2 py-1.5">Loading membership catalog…</div>}
          {error && <div className="text-xs text-red-300 px-2 py-1.5">{error}</div>}
          {!loading && !error && memberships && (
            <>
              <button
                type="button"
                onClick={() => { onChange(null, null); setOpen(false) }}
                className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-gray/40 ${!membershipId ? 'text-blue-300' : ''}`}
              >
                Clear
                <div className="text-xs text-un1t-light">No trial attached on Glofox account creation. CRM will create the account but not assign any membership.</div>
              </button>
              <div className="border-t border-un1t-gray/50 my-1" />
              {memberships.length === 0 && (
                <div className="text-xs text-un1t-light px-2 py-1.5">No memberships in this Glofox studio yet.</div>
              )}
              {memberships.map((m) => (
                <div key={m._id} className="border-b border-un1t-gray/30 last:border-b-0 pb-1.5 mb-1.5 last:mb-0 last:pb-0">
                  <div className="px-2 text-xs font-medium text-un1t-light">
                    {m.name}
                    {m.trial && <span className="ml-1 text-amber-300/80">· trial</span>}
                  </div>
                  {m.plans.map((p) => (
                    <button
                      key={p.code}
                      type="button"
                      onClick={() => { onChange(m._id, p.code); setOpen(false) }}
                      className={`w-full text-left text-sm px-3 py-1.5 rounded hover:bg-un1t-gray/40 ${
                        membershipId === m._id && planCode === p.code ? 'text-blue-300' : ''
                      }`}
                    >
                      <span>{p.name || p.code}</span>
                      <span className="text-xs text-un1t-light ml-2">
                        €{p.price} · {p.type}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
