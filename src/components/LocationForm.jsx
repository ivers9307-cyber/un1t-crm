'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function LocationForm({ location, callerRole = 'owner', organizations = [], showEmailTab = false }) {
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

  // SETTINGS.1 follow-up — Twilio alpha sender ID moved to its own
  // tab in <LocationIntegrations>. Not read here anymore.

  // Roster v2 phase 4 — monthly contractor labour budget (mig 071).
  // Stored as numeric euros; null = not configured. FTE labour
  // is NOT counted against this — only contractor hours × rate.
  const [contractorBudget, setContractorBudget] = useState(
    location?.monthly_contractor_budget_eur != null ? String(location.monthly_contractor_budget_eur) : ''
  )

  // INVOICES.1 — local part of the per-location invoice forwarding
  // address. Empty = inbound ingest off. DB CHECK enforces the slug
  // regex (`^[a-z0-9][a-z0-9-]{1,40}$`); we mirror it client-side
  // for a nicer error and to keep the input feedback immediate.
  const [invoicesInboundSlug, setInvoicesInboundSlug] = useState(
    location?.invoices_inbound_slug || ''
  )
  const INVOICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
  const invoiceSlugInvalid = invoicesInboundSlug.length > 0 && !INVOICE_SLUG_RE.test(invoicesInboundSlug)

  // EMAIL-MAILBOX-ADMIN.1 — the "Email Inbox / Reply-To" field that used to
  // live here is GONE. It wrote locations.email_inbox_reply_to, which mig 485
  // deprecated in favour of email_mailboxes: a studio has many accounts now
  // (studio@, accounts@, sales@), each separately permissioned, and a single
  // text input cannot express that. Worse, it still LOOKED authoritative —
  // editing it implied you were changing where mail routes, which it no
  // longer does (the inbound webhook resolves the recipient against
  // email_mailboxes and dead-letters on no match). The replacement is the
  // Email tab on this page (<EmailMailboxesCard>). The column stays on disk,
  // read-only, per the deprecated-column convention.

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
    if (invoiceSlugInvalid) {
      setError('Invoice forwarding slug must be 2–41 chars: lowercase letters, digits, hyphens (must start with a letter or digit).')
      setSaving(false)
      return
    }
    // Shared field normalisation (create + edit).
    // mig 071 — null = not configured (summary panel shows total spend
    // without an over/under chip). 0 IS valid and means "no contractor
    // labour allowed", which the panel treats as "always over budget".
    const contractorBudgetValue = contractorBudget.trim() === ''
      ? null
      : (Number.isFinite(Number(contractorBudget)) ? Number(contractorBudget) : null)
    // INVOICES.1 — null = inbound invoice ingest disabled.
    const invoicesSlugValue = invoicesInboundSlug.trim() === '' ? null : invoicesInboundSlug.trim()

    if (isEditing) {
      // Edits stay browser-side (RLS-checked). SETTINGS.1 —
      // sensibo/glofox/unifi/twilio slices are owned by the per-tab
      // Integrations save endpoints; untouched columns are left alone.
      const payload = {
        name,
        slug,
        address: address || null,
        phone: phone || null,
        email: email || null,
        timezone,
        country,
        active,
        // mig 079 — org is read-only when editing (cross-org moves are
        // rare and risky; do them via SQL with intent).
        organization_id: location.organization_id,
        monthly_contractor_budget_eur: contractorBudgetValue,
        invoices_inbound_slug: invoicesSlugValue,
        // email_inbox_reply_to is DELIBERATELY absent — deprecated by mig 485
        // and superseded by email_mailboxes (the Email tab). Omitting the key
        // leaves the existing value untouched rather than nulling it.
        updated_at: new Date().toISOString(),
      }
      const result = await db.from('locations').update(payload).eq('id', location.id).select().single()
      if (result.error) {
        setError(result.error.message)
        setSaving(false)
        return
      }
    } else {
      // SAAS4-W0.1 — creation goes through POST /api/locations so the
      // server seeds the per-location defaults (FUNNEL.1 pipeline
      // stages from the classifier SSOT). The old browser-side insert
      // seeded a stale pre-FUNNEL taxonomy that broke classification
      // for any location created after mig 350.
      let json
      try {
        const res = await fetch('/api/locations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            organization_id: organizationId,
            address: address || null,
            phone: phone || null,
            email: email || null,
            timezone,
            country,
            active,
            monthly_contractor_budget_eur: contractorBudgetValue,
            invoices_inbound_slug: invoicesSlugValue,
            // No email_inbox_reply_to: a new studio's inbound address is an
            // email_mailboxes row now, added from the Email tab once the
            // location exists.
          }),
        })
        json = await res.json()
      } catch {
        json = { success: false, error: 'Network error creating the location. Try again.' }
      }
      if (!json.success) {
        setError(json.error || 'Failed to create the location.')
        setSaving(false)
        return
      }
    }

    router.push('/settings')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Location Details</h3>

        {/* Organization picker (mig 079). Required when creating; read-only when editing. */}
        {organizations.length > 0 && (
          <div>
            <label className="block text-sm mb-1.5">Organization *</label>
            {isEditing ? (
              <div className="w-full bg-un1t-bg/60 border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-subtle">
                {organizations.find(o => o.id === location?.organization_id)?.name || '—'}
                <span className="ml-2 text-[11px] text-un1t-muted">(read-only — moving locations between orgs is rare; do via SQL with intent)</span>
              </div>
            ) : (
              <select
                required
                value={organizationId}
                onChange={e => setOrganizationId(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
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
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="123 Example St, Dublin 2"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
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
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="info@un1t.ie"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Country</label>
            <select
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
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
            <p className="text-xs text-un1t-muted mt-1">Drives the public-holiday list on the schedule. All listed countries have built-in holidays through 2030.</p>
          </div>
          <div>
            <label className="block text-sm mb-1.5">Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
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
                active ? 'bg-green-500/20 text-green-700' : 'bg-red-500/20 text-red-700'
              }`}
            >
              {active ? 'Active' : 'Inactive'}
            </button>
          </div>
        )}
      </div>

      {/* SETTINGS.1 follow-up — SMS (Twilio) alpha sender ID moved
          into the TwilioIntegrationTab under <LocationIntegrations>
          so all integration-y per-location config lives in one place. */}

      {/* Roster v2 phase 4 — Monthly contractor labour budget (mig 071).
          FTE labour is sunk cost and doesn't count; this ceiling
          tracks contractor hours × hourly_rate for the month. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Coaching Budget</h3>
        <p className="text-xs text-un1t-muted">
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
            className="w-48 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
          <p className="text-[11px] text-un1t-muted mt-1">
            Phase 5 will add an owner-approval gate when a published roster exceeds this budget. Right now the summary panel below the schedule is read-only / advisory.
          </p>
        </div>
      </div>


      {/* INVOICES.1 — Dext-style inbound invoice ingest. Slug must
          be unique across all locations (partial unique index in
          mig 184). Leave blank to disable inbound ingest for this
          studio — the /invoices inbox still works for direct
          uploads but no forwarded email will route here. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Invoice Forwarding</h3>
        <p className="text-xs text-un1t-muted">
          Forward supplier invoices to <code className="text-un1t-subtle">{(invoicesInboundSlug || '<slug>')}-invoices@mail.un1tdublin.com</code> and they&apos;ll land in <a href="/invoices" className="underline text-un1t-subtle">Invoices</a> awaiting quality review. Lowercase letters, digits, hyphens only. Must be unique across locations. Leave blank to disable.
        </p>

        <div>
          <label className="block text-sm mb-1.5">Forwarding slug</label>
          <input
            type="text"
            value={invoicesInboundSlug}
            onChange={e => setInvoicesInboundSlug(e.target.value.toLowerCase())}
            placeholder="e.g. dublin-city"
            className={`w-64 bg-un1t-bg border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted ${
              invoiceSlugInvalid ? 'border-red-500' : 'border-un1t-border'
            }`}
          />
          {invoiceSlugInvalid && (
            <p className="text-[11px] text-red-400 mt-1">
              Must be 2–41 chars, start with a letter or digit, lowercase only.
            </p>
          )}
        </div>
      </div>


      {/* EMAIL-MAILBOX-ADMIN.1 — the single "Email Inbox / Reply-To" field
          that used to sit here is gone; a studio has many accounts now, each
          separately permissioned. Pointer, not a form: the editor lives on
          the Email tab of this page, which is master/owner-gated. */}
      {isEditing && showEmailTab && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-2">
          <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Email Accounts</h3>
          <p className="text-xs text-un1t-muted">
            This studio&apos;s inbound email addresses — and who may read each one — are managed on the{' '}
            <a href="?section=email" className="underline text-un1t-subtle">Email tab</a>. A studio can
            run several (studio@, accounts@, sales@); the default account is the one stamped as
            Reply-To on campaign and marketing sends.
          </p>
        </div>
      )}


      {/* Submit */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-un1t-text text-un1t-bg text-sm font-medium px-5 py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEditing ? 'Update Location' : 'Create Location'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/settings')}
          className="text-sm text-un1t-subtle hover:text-un1t-text transition-colors px-4 py-2.5"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

