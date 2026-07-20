'use client'

// INTEG hub inline #4 — the per-card "Manage" slide-over.
//
// PHASE 1 hosted the EXISTING per-location surfaces inline:
//   ads       → AdsIntegrationTab (saves via PUT /api/settings/ads)
//   instagram → ConnectionsSection (embedded)
//
// PHASE 3 adds two compact connect/disconnect panels that reuse EXISTING
// routes verbatim — inventing no new routing/activation logic:
//   xero      → Connect/Reconnect kicks off the full-page OAuth redirect
//               (GET /api/xero/connect?location_id=…&return_to=/settings/
//               integrations-hub — the return_to guard shipped in Phase-3
//               part 1); Disconnect → POST /api/xero/disconnect.
//   whatsapp  → the SHARED ConnectWhatsAppCard (Meta Embedded Signup popup,
//               GET/POST …/whatsapp/embedded-signup) + per-number Disconnect
//               that calls the SAME DELETE …/whatsapp/numbers/[numberId] the
//               tab calls, with the tab's exact confirm() copy + semantics
//               (never touches a different number, no reactivation). The
//               heavy config for both stays on the "Advanced settings"
//               deep-link ("Xero data & accounts" / "Manage numbers").
//               WhatsApp is the LIVE customer channel — no send/routing code
//               is touched here; connect + per-number disconnect only.
//
// PHASE 2 adds first-class inline Manage forms for the credential-bearing
// providers stored on the `locations` row, saving through ONE new
// service-role route — PUT/DELETE /api/locations/[id]/integrations/[provider]:
//   glofox   (Tier 1, ADMIN_ROLES)  — branch/keys/token/webhook secret
//   sms      (Tier 2, ADMIN_ROLES)  — Twilio alpha sender ID (NOT a secret)
//   unifi    (Tier 3, MASTER-ONLY)  — host/token/policy ids
//   climate  (Tier 3, MASTER-ONLY)  — Sensibo + LG ThinQ CREDS (device table
//                                     stays on the Advanced-settings deep-link)
//   bca      (Tier 3, MASTER-ONLY)  — BCA email + templates (doc slots stay
//                                     on the deep-link; bca_config has NO secret)
//
// WRITE-ONLY secrets: secret inputs render BLANK with a "currently set / not
// set" caption — a blank field KEEPS the stored secret (the route's
// integration-secret-merge guard), a typed value replaces it. The hub only
// ever receives has_* booleans + non-secret values (never a token). Master-
// only providers render READ-ONLY for a non-master viewer. On a successful
// save/disconnect the drawer calls onChanged() so the hub re-grades from one
// scoped GET /api/integrations/hub.
//
// Accessibility (unchanged from Phase 1): role=dialog + aria-modal, ESC
// closes, focus trap, focus restored to the opener, body-scroll lock,
// motion-safe transitions, type="button" on every non-submit control.

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { X, Save, Loader2, Check, AlertCircle, Unplug, Plug, RefreshCw } from 'lucide-react'
import { buttonClasses } from '@/components/ui'
import AdsIntegrationTab from './integrations/AdsIntegrationTab'
import { ConnectWhatsAppCard } from './integrations/ConnectWhatsAppCard'
import ConnectionsSection from '@/components/customer-agent/ConnectionsSection'

// cardKey → { title, routeProvider, tabKey, masterOnly, intro, fields }.
// `fields`: name (payload key) + label + kind. Secret fields carry has()
// (presence off the hub row); non-secret fields carry from() (prefill value).
const FORM_SPECS = {
  glofox: {
    title: 'Glofox',
    routeProvider: 'glofox',
    tabKey: 'glofox',
    masterOnly: false,
    intro:
      'Booking + member source. The three-header auth (Branch ID + API Key + API Token) is required by Glofox v3; the webhook secret signs incoming Glofox webhooks. Leave a secret blank to keep the stored value.',
    fields: [
      { name: 'branch_id', label: 'Branch ID', mono: true, from: (i) => i?.branchId },
      { name: 'api_key', label: 'API Key', secret: true, has: (i) => i?.hasApiKey },
      { name: 'api_token', label: 'API Token', secret: true, has: (i) => i?.hasApiToken },
      { name: 'webhook_secret', label: 'Webhook Secret', secret: true, has: (i) => i?.hasWebhookSecret },
      { name: 'namespace', label: 'Namespace', mono: true, from: (i) => i?.namespace, hint: 'Required for /Analytics/report queries. Glofox provides this on request.' },
    ],
    advancedHint: 'Trial membership + hidden-class settings live under Advanced settings.',
  },
  sms: {
    title: 'Twilio (SMS)',
    routeProvider: 'twilio',
    tabKey: 'twilio',
    masterOnly: false,
    intro:
      'Twilio account credentials are global env vars; only the per-location branded alpha sender ID is set here (max 11 alphanumeric chars). Leave blank to use the global fallback.',
    fields: [
      { name: 'sender_id', label: 'Alpha Sender ID', mono: true, maxLength: 11, from: (i) => i?.senderId, placeholder: 'e.g. UN1T STILL' },
    ],
  },
  unifi: {
    title: 'UniFi Access',
    routeProvider: 'unifi',
    tabKey: 'unifi',
    masterOnly: true,
    intro:
      'Door-access controller. Host must be reachable from Vercel (Cloudflare Tunnel). API token needs view:user / edit:user / view:policy. Leave the token blank to keep the stored value.',
    fields: [
      { name: 'host', label: 'Host', mono: true, from: (i) => i?.host, placeholder: 'https://unifi.example.com:12445' },
      { name: 'api_token', label: 'API Token', secret: true, has: (i) => i?.hasToken },
      { name: 'staff_policy_id', label: 'Staff policy ID', mono: true, from: (i) => i?.staffPolicyId },
      { name: 'manager_policy_id', label: 'Manager policy ID', mono: true, from: (i) => i?.managerPolicyId },
      { name: 'allow_self_signed', label: 'Allow self-signed certs', toggle: true, from: (i) => i?.allowSelfSigned === true },
    ],
  },
  climate: {
    title: 'Climate devices',
    routeProvider: 'ac',
    tabKey: 'ac-devices',
    masterOnly: true,
    intro:
      'Sensibo + LG ThinQ credentials for this location. Leave a secret blank to keep the stored value. Adding/removing the device units themselves stays under Advanced settings.',
    fields: [
      { name: 'sensibo_api_key', label: 'Sensibo API key', secret: true, has: (i) => i?.sensibo?.hasKey },
      { name: 'thinq_pat', label: 'LG ThinQ PAT', secret: true, has: (i) => i?.thinq?.hasPat },
      { name: 'thinq_client_id', label: 'ThinQ Client ID', mono: true, from: (i) => i?.thinq?.clientId, hint: 'uuid4 — auto-generated server-side on first save if left blank.' },
      { name: 'thinq_country_code', label: 'ThinQ Country code', mono: true, maxLength: 8, from: (i) => i?.thinq?.countryCode || 'IE' },
    ],
    advancedHint: 'The per-unit device table (discover / enable / defaults) lives under Advanced settings.',
  },
  bca: {
    title: 'BCA Submit',
    routeProvider: 'bca',
    tabKey: 'bca',
    masterOnly: true,
    intro:
      'BCA VAT-claim email. Send-from must be a Postmark-approved sender. No secrets are stored here. The document-slot labels stay under Advanced settings.',
    fields: [
      { name: 'send_from', label: 'Send from', from: (i) => i?.sendFrom, placeholder: 'vat-claims@ccfautos.com' },
      { name: 'send_to', label: 'Send to (BCA recipient)', from: (i) => i?.sendTo, placeholder: 'vatclaims@bca.example' },
      { name: 'cc', label: 'CC (optional)', from: (i) => i?.cc, placeholder: 'ops@ccfautos.com' },
      { name: 'subject_template', label: 'Subject template', mono: true, from: (i) => i?.subjectTemplate },
      { name: 'body_template', label: 'Body template', mono: true, textarea: true, from: (i) => i?.bodyTemplate },
    ],
    advancedHint: 'The document-slot labels + live preview live under Advanced settings.',
  },
}

const TITLES = { ads: 'Meta Ads', instagram: 'Instagram', xero: 'Xero', whatsapp: 'WhatsApp' }
const TAB_KEY = { ads: 'ads', instagram: 'instagram', xero: 'xero', whatsapp: 'whatsapp' }
// Phase 3 — the footer deep-link label for the compact connect/disconnect
// panels: the drawer handles the common connect/disconnect inline, and the
// heavy per-provider config stays one click away in the existing tab.
const DEEP_LINK_LABEL = { xero: 'Xero data & accounts', whatsapp: 'Manage numbers' }

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export default function IntegrationsHubDrawer({ cardKey, locationId, locationName, initial, isMaster = false, onClose, onChanged }) {
  const panelRef = useRef(null)
  const titleId = useId()
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return undefined
    const opener = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusables = () => Array.from(panel.querySelectorAll(FOCUSABLE))
    ;(focusables()[0] || panel).focus()

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKey)
    return () => {
      panel.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
  }, [onClose])

  const spec = FORM_SPECS[cardKey]
  const title = spec?.title || TITLES[cardKey] || 'Integration'
  const tabKey = spec?.tabKey || TAB_KEY[cardKey]

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 motion-safe:transition-opacity motion-safe:duration-200 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`fixed inset-y-0 right-0 z-50 w-[540px] max-w-[94vw] flex flex-col bg-un1t-bg border-l border-un1t-border shadow-2xl outline-none transform motion-safe:transition-transform motion-safe:duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-un1t-border px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-un1t-text">Manage {title}</h2>
            {locationName && <p className="text-xs text-un1t-subtle mt-0.5 truncate">{locationName}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-un1t-subtle hover:bg-un1t-surface hover:text-un1t-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {cardKey === 'ads' && (
            <AdsIntegrationTab location={{ id: locationId, name: locationName }} canEdit onChanged={onChanged} />
          )}
          {cardKey === 'instagram' && (
            <ConnectionsSection locationId={locationId} locationName={locationName} embedded onChanged={onChanged} />
          )}
          {cardKey === 'xero' && (
            <XeroPanel
              locationId={locationId}
              locationName={locationName}
              initial={initial}
              onChanged={onChanged}
              onDisconnected={onClose}
            />
          )}
          {cardKey === 'whatsapp' && (
            <WhatsAppPanel
              locationId={locationId}
              locationName={locationName}
              initial={initial}
              onChanged={onChanged}
            />
          )}
          {spec && (
            <IntegrationCredForm
              spec={spec}
              locationId={locationId}
              initial={initial}
              readOnly={spec.masterOnly && !isMaster}
              onChanged={onChanged}
              onDisconnected={onClose}
            />
          )}
        </div>

        {tabKey && (
          <div className="border-t border-un1t-border px-5 py-2.5">
            <Link
              href={`/settings/locations/${locationId}?tab=${tabKey}`}
              className={buttonClasses({ variant: 'secondary', size: 'sm' })}
            >
              {DEEP_LINK_LABEL[cardKey] || 'Advanced settings'}
            </Link>
          </div>
        )}
      </aside>
    </>
  )
}

// ── The per-provider credential form (Phase 2) ──
function IntegrationCredForm({ spec, locationId, initial, readOnly, onChanged, onDisconnected }) {
  // Build initial input state: non-secret fields prefilled, secret fields BLANK.
  const [values, setValues] = useState(() => {
    const v = {}
    for (const f of spec.fields) {
      if (f.secret) v[f.name] = ''
      else if (f.toggle) v[f.name] = !!(f.from ? f.from(initial) : false)
      else v[f.name] = (f.from ? f.from(initial) : '') ?? ''
    }
    return v
  })
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const url = `/api/locations/${locationId}/integrations/${spec.routeProvider}`

  function set(name, val) {
    setValues((prev) => ({ ...prev, [name]: val }))
  }

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(values),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) {
        setError(j.error || (j.issues && j.issues[0]?.message) || `Save failed (${res.status})`)
        return
      }
      // Clear any typed secret from local state (never keep it around) — it's
      // stored now and reads back as a presence boolean.
      setValues((prev) => {
        const next = { ...prev }
        for (const f of spec.fields) if (f.secret) next[f.name] = ''
        return next
      })
      setSavedAt(new Date())
      onChanged?.()
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${spec.title} for this location? Stored credentials are cleared and the connection is deactivated (not deleted). You can reconnect here anytime.`)) return
    setDisconnecting(true); setError(null)
    try {
      const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) {
        setError(j.error || `Disconnect failed (${res.status})`)
        setDisconnecting(false)
        return
      }
      onChanged?.()
      onDisconnected?.()
    } catch (e) {
      setError(e.message || 'Network error')
      setDisconnecting(false)
    }
  }

  // Read-only view for a non-master viewer of a master-only provider.
  if (readOnly) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-un1t-subtle">{spec.intro}</p>
        <div className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2 text-xs text-un1t-subtle">
          {spec.title} is master-only. You can see its status but only a master account can edit its credentials.
        </div>
        <dl className="space-y-2">
          {spec.fields.map((f) => (
            <div key={f.name} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-un1t-subtle">{f.label}</dt>
              <dd className="text-un1t-text font-mono text-xs">
                {f.secret
                  ? (f.has?.(initial) ? 'Set' : 'Not set')
                  : f.toggle
                    ? (f.from?.(initial) ? 'On' : 'Off')
                    : (f.from?.(initial) || '—')}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">{spec.intro}</p>

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

      {spec.fields.map((f) => {
        if (f.toggle) {
          return (
            <div key={f.name} className="flex items-center justify-between border border-un1t-border rounded-md px-3 py-2">
              <span className="text-sm text-un1t-text">{f.label}</span>
              <button
                type="button"
                aria-pressed={!!values[f.name]}
                onClick={() => set(f.name, !values[f.name])}
                className={`w-10 h-5 rounded-full transition-colors ${values[f.name] ? 'bg-green-500' : 'bg-un1t-border'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${values[f.name] ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          )
        }
        return (
          <div key={f.name}>
            <label className="block text-xs text-un1t-subtle mb-1">{f.label}</label>
            {f.textarea ? (
              <textarea
                value={values[f.name]}
                onChange={(e) => set(f.name, e.target.value)}
                rows={6}
                className={`w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text ${f.mono ? 'font-mono' : ''}`}
              />
            ) : (
              <input
                type="text"
                value={values[f.name]}
                onChange={(e) => set(f.name, e.target.value)}
                maxLength={f.maxLength}
                placeholder={f.secret ? (f.has?.(initial) ? '•••••• (leave blank to keep)' : 'Not set') : (f.placeholder || '')}
                className={`w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text ${f.mono ? 'font-mono' : ''}`}
              />
            )}
            {f.secret && (
              <p className="text-[11px] text-un1t-muted mt-1">
                {f.has?.(initial)
                  ? 'Currently set. Leave blank to keep it, or enter a new value to replace it.'
                  : 'Not set yet.'}
              </p>
            )}
            {f.hint && <p className="text-[11px] text-un1t-muted mt-1">{f.hint}</p>}
          </div>
        )
      })}

      {spec.advancedHint && <p className="text-[11px] text-un1t-muted">{spec.advancedHint}</p>}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-un1t-border/40">
        <button
          type="button"
          onClick={disconnect}
          disabled={disconnecting || saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-un1t-border text-sm text-red-700 hover:bg-red-500/10 disabled:opacity-50"
        >
          {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />} Disconnect
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || disconnecting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <><Loader2 size={12} className="animate-spin" /> Saving…</> : <><Save size={12} /> Save</>}
        </button>
      </div>
    </div>
  )
}

// ── Xero connect/disconnect panel (Phase 3) ──
//
// Connect/Reconnect starts the EXISTING full-page OAuth flow
// (GET /api/xero/connect) with return_to=/settings/integrations-hub so the
// callback bounces the browser back to the hub (the return_to guard shipped
// in Phase-3 part 1). Disconnect posts the EXISTING /api/xero/disconnect with
// this location's id and the tab's exact confirm() copy. No new route, no
// token rendered. `initial` is the assembled hub xero row (present only when
// connected); its absence renders the not-connected Connect-only state.
function XeroPanel({ locationId, locationName, initial, onChanged, onDisconnected }) {
  const connected = !!initial && initial.status !== 'not_connected'
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState(null)

  function connect() {
    // Full-page redirect — the OAuth handshake needs a top-level navigation;
    // return_to (allowlist-guarded) returns the browser to the hub, which
    // re-assembles fresh, so no in-place re-grade is needed here.
    const returnTo = '/settings/integrations-hub'
    window.location.href =
      `/api/xero/connect?location_id=${encodeURIComponent(locationId)}&return_to=${encodeURIComponent(returnTo)}`
  }

  async function disconnect() {
    if (!confirm(`Disconnect Xero from ${locationName || 'this location'}? Future invoice pushes will fail until you reconnect.`)) return
    setDisconnecting(true); setError(null)
    try {
      const res = await fetch('/api/xero/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ location_id: locationId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) {
        setError(j.error || `Disconnect failed (${res.status})`)
        setDisconnecting(false)
        return
      }
      onChanged?.()
      onDisconnected?.()
    } catch (e) {
      setError(e.message || 'Network error')
      setDisconnecting(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Accounting sync. Connecting starts Xero&apos;s OAuth consent in this window and returns you
        here. Used to push customer invoices and forward supplier docs into Xero&apos;s Bills inbox.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}

      {connected ? (
        <div className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2 text-xs text-un1t-subtle space-y-0.5">
          <div>
            Connected to <span className="text-un1t-text font-medium">{initial.tenantName}</span>
          </div>
          {initial.connectedAt && (
            <div>Linked {new Date(initial.connectedAt).toLocaleDateString()}{initial.lastRefreshedAt ? ` · refreshed ${new Date(initial.lastRefreshedAt).toLocaleDateString()}` : ''}</div>
          )}
          {initial.status === 'error' && initial.message && (
            <div className="text-red-700">{initial.message}</div>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-un1t-border bg-un1t-surface px-3 py-2 text-xs text-un1t-subtle">
          No Xero organisation connected at this location.
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-un1t-border/40">
        {connected ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={disconnecting}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-un1t-border text-sm text-red-700 hover:bg-red-500/10 disabled:opacity-50"
          >
            {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />} Disconnect
          </button>
        ) : <span />}
        <button
          type="button"
          onClick={connect}
          disabled={disconnecting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {connected ? <><RefreshCw size={12} /> Reconnect</> : <><Plug size={12} /> Connect</>}
        </button>
      </div>
    </div>
  )
}

// ── WhatsApp connect/disconnect panel (Phase 3) ──
//
// The SHARED ConnectWhatsAppCard (Meta Embedded Signup) drives connect,
// verbatim — same GET/POST …/whatsapp/embedded-signup flow the tab uses.
// Below it, each already-connected number gets a Disconnect button that calls
// the SAME DELETE …/whatsapp/numbers/[numberId] the tab's remove() calls, with
// the tab's exact confirm() copy + semantics: it targets ONLY that number's
// id, never reactivates anything, and never touches a different number. The
// numbers list is kept in local state (seeded from the assembled hub row) so a
// per-number disconnect updates the panel without re-plumbing the drawer's
// `initial`; onChanged still re-grades the hub card behind the drawer. The
// full numbers UI (add/edit/default/token) stays on the "Manage numbers"
// deep-link — WhatsApp is the LIVE customer channel, so this panel does the
// two safe operations only.
function WhatsAppPanel({ locationId, locationName, initial, onChanged }) {
  const [numbers, setNumbers] = useState(() => (Array.isArray(initial?.numbers) ? initial.numbers : []))
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  async function disconnectNumber(number) {
    // The tab's EXACT confirm copy + fallback semantics — unchanged.
    if (!confirm(`Remove "${number.label}"? Any sends to / from this number will fall back to the location's other configured number, or the env-var default.`)) return
    setBusyId(number.id); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/numbers/${number.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) {
        setError(j.error || `Disconnect failed (${res.status})`)
        setBusyId(null)
        return
      }
      // Drop just this number from the local list; re-grade the hub behind us.
      setNumbers((prev) => prev.filter((n) => n.id !== number.id))
      setBusyId(null)
      onChanged?.()
    } catch (e) {
      setError(e.message || 'Network error')
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        WhatsApp Cloud API. Connect onboards a number through Meta&apos;s guided signup; each
        connected number can be disconnected below (it falls back to another number or the
        env-var default). Editing tokens, labels and the default number stays on Manage numbers.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}

      {numbers.length > 0 && (
        <div className="rounded-md border border-un1t-border divide-y divide-un1t-border">
          {numbers.map((n) => (
            <div key={n.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-un1t-text truncate">{n.label}</div>
                <div className="text-[11px] text-un1t-subtle truncate">
                  {n.displayPhone || n.id}
                  {n.isDefault ? ' · default' : ''}
                  {n.source === 'coexistence' ? ' · coexistence' : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => disconnectNumber(n)}
                disabled={busyId === n.id}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-un1t-border text-xs text-red-700 hover:bg-red-500/10 disabled:opacity-50"
              >
                {busyId === n.id ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />} Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The shared Embedded Signup card — identical to the WhatsApp tab. The
          hub page is owner+/master gated and the route re-checks master-or-
          owner, so connecting is permitted for every hub viewer. */}
      <ConnectWhatsAppCard
        location={{ id: locationId, name: locationName }}
        canEdit
        onConnected={onChanged}
      />
    </div>
  )
}
