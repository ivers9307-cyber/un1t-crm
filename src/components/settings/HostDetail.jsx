'use client'

// EVENTS-HOST.2 — event host detail: editable profile (name / email /
// booking fee), the Stripe Connect "Connect with Stripe" flow, live
// status badges, and the ?stripe=return → sync-on-load behaviour.
//
// Data comes from the /api/hosts/[id] routes (session cookies ride
// along; standard { success, data?, error? } envelope). Stripe's hosted
// onboarding returns the browser to /settings/hosts/<id>?stripe=return —
// when we see that flag on mount we POST .../stripe/sync to re-pull the
// live account status, then strip the flag from the URL so a refresh
// doesn't re-sync.

import { useState, useEffect, useCallback } from 'react'
import {
  CreditCard, Check, Minus, Save, RefreshCw, AlertTriangle, ExternalLink, Store,
  Link2, Copy, Trash2, Mail,
} from 'lucide-react'
import { Button, Card, Field, Loading } from '@/components/ui'
import { hostCanTakePayments, PROVIDER_STRIPE_CONNECT } from '@/lib/event-hosts'
// Pure label sanitizer shared with the provisioning route — no server-only
// imports in that module, so the client bundle can reuse it for the hint.
import { sanitizeDomainLabel } from '@/lib/postmark-domains'

function centsToEuroInput(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n) || n <= 0) return ''
  return (n / 100).toFixed(2)
}
function euroInputToCents(euros) {
  const n = parseFloat(String(euros).replace(',', '.'))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

const INPUT_CLASS =
  'w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm ' +
  'text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'

// A single onboarding-status flag rendered as a light-theme chip
// (bg-<c>-500/10 text-<c>-700 — the only recipe check:guardrails accepts).
function StatusFlag({ ok, label }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ' +
        (ok ? 'bg-green-500/10 text-green-700' : 'bg-gray-500/10 text-gray-700')
      }
    >
      {ok ? <Check size={12} /> : <Minus size={12} />}
      {label}
    </span>
  )
}

function fmtEuro(cents, currency = 'EUR') {
  const n = Number(cents)
  const safe = Number.isFinite(n) ? n : 0
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(safe / 100)
  } catch {
    return `€${(safe / 100).toFixed(2)}`
  }
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-un1t-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-un1t-text tabular-nums">{value}</p>
    </div>
  )
}

// One DNS value with a copy button — the operator pastes these into the
// un1tdublin.com zone, so exact copies matter more than pretty rendering.
function CopyValue({ label, value, copiedKey, onCopy }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-12 shrink-0 text-[11px] uppercase tracking-wide text-un1t-muted">{label}</span>
      <code className="flex-1 truncate rounded bg-un1t-bg border border-un1t-border px-2 py-1 font-mono text-xs text-un1t-text">
        {value}
      </code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={copiedKey === value ? Check : Copy}
        onClick={() => onCopy(value)}
        className="shrink-0"
      >
        {copiedKey === value ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

// HOST-EMAIL.5 — sender defaults, editable directly: the from-address, the
// display name, and an explicit Reply-To for the host's campaign emails.
// The email-domain flow above also writes sender_email/sender_name when it
// provisions a dedicated domain; this card lets an operator set an interim
// from-address on an already-verified domain (e.g. host@un1tdublin.com)
// without provisioning, and control where replies land (blank Reply-To
// falls back to the host's login email).
function SenderDefaultsCard({ hostId, host, applyHost }) {
  const [senderEmail, setSenderEmail] = useState(host?.sender_email || '')
  const [senderName, setSenderName] = useState(host?.sender_name || '')
  const [replyTo, setReplyTo] = useState(host?.reply_to_email || '')
  const [streamId, setStreamId] = useState(host?.postmark_stream_id || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  async function save(e) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_email: senderEmail.trim() || null,
          sender_name: senderName.trim() || null,
          reply_to_email: replyTo.trim() || null,
          postmark_stream_id: streamId.trim() || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      applyHost(j.data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Sender defaults">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Send from email">
            <input
              type="email"
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              placeholder="host@un1tdublin.com"
              className="w-full border border-un1t-border rounded-md px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Sender name">
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              maxLength={200}
              placeholder={host?.name || 'Sender name'}
              className="w-full border border-un1t-border rounded-md px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Reply-to email">
          <input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder={host?.email || 'Falls back to the host login email'}
            className="w-full border border-un1t-border rounded-md px-3 py-2 text-sm"
          />
          <p className="text-xs text-un1t-subtle mt-1">
            Where replies to campaign emails land. Leave blank to use the host&apos;s login email{host?.email ? ` (${host.email})` : ''}.
          </p>
        </Field>
        <Field label="Postmark marketing stream">
          <input
            type="text"
            value={streamId}
            onChange={(e) => setStreamId(e.target.value)}
            maxLength={64}
            placeholder="colm-events"
            className="w-full border border-un1t-border rounded-md px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-un1t-subtle mt-1">
            The host&apos;s own Postmark Broadcasts stream ID. Create it in Postmark (Message Streams → Create → Broadcasts, unsubscribe handling Custom), add a webhook on that stream to <code>/api/webhooks/postmark</code> with all six events and the <code>x-webhook-token</code> header, then paste the ID here. Marketing sends are blocked until this is set; utility emails are unaffected.
          </p>
        </Field>
        <p className="text-xs text-un1t-subtle">
          The from-address must be on a domain that&apos;s verified for sending — a dedicated
          host domain from the card above, or an un1tdublin.com address as an interim.
        </p>
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex items-center gap-3">
          <Button type="submit" icon={Save} loading={saving}>Save sender defaults</Button>
          {saved && <span className="text-xs text-green-700">Saved.</span>}
        </div>
      </form>
    </Card>
  )
}

// "Email sending" (HOST-EMAIL.2) — provision the host's dedicated Postmark
// sending domain (<label>.mail.un1tdublin.com), show the DKIM/Return-Path
// DNS records to add to the un1tdublin.com zone, re-check verification, and
// (once verified) offer the per-host kill switch. Backed by
// POST /api/hosts/[id]/email-domain (+ /verify) — the provision route is
// idempotent, so a provisioned host's mount-fetch is a plain state read.
function EmailSendingCard({ hostId, host }) {
  const [provisioned, setProvisioned] = useState(!!host?.postmark_domain_id)
  const [state, setState] = useState(null) // { domain, sender_email, sender_name, slug, verified, dkim_verified, return_path_verified, records }
  const [stateLoading, setStateLoading] = useState(!!host?.postmark_domain_id)
  const [label, setLabel] = useState(sanitizeDomainLabel(host?.name || ''))
  const [senderName, setSenderName] = useState(host?.sender_name || host?.name || '')
  const [provisioning, setProvisioning] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState(null)
  const [copiedKey, setCopiedKey] = useState(null)

  // The idempotent provision POST doubles as the state read for an
  // already-provisioned host — one call returns domain + records + flags.
  const fetchState = useCallback(async () => {
    setStateLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/email-domain`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setState(j.data)
      setProvisioned(true)
    } catch (e) {
      setError(e.message || 'Could not load the sending domain.')
    } finally {
      setStateLoading(false)
    }
  }, [hostId])

  useEffect(() => {
    if (host?.postmark_domain_id) fetchState()
    // Keyed on the host row's domain id — runs once per provisioned host.
  }, [host?.postmark_domain_id, fetchState])

  async function provision() {
    if (provisioning) return
    setProvisioning(true)
    setError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/email-domain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(senderName.trim() ? { sender_name: senderName.trim() } : {}),
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setState(j.data)
      setProvisioned(true)
    } catch (e) {
      setError(e.message || 'Could not provision the sending domain.')
    } finally {
      setProvisioning(false)
    }
  }

  // verified: false = the kill switch; an empty body = re-check with Postmark.
  async function postVerify(body) {
    const res = await fetch(`/api/hosts/${hostId}/email-domain/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
    return j.data
  }

  async function verify() {
    if (verifying) return
    setVerifying(true)
    setError(null)
    try {
      setState(await postVerify({}))
    } catch (e) {
      setError(e.message || 'Verification check failed.')
    } finally {
      setVerifying(false)
    }
  }

  async function disableSending() {
    if (disabling) return
    if (!window.confirm('Disable sending for this host?\n\nTheir campaigns will be blocked until you verify the domain again. DNS records are unaffected.')) return
    setDisabling(true)
    setError(null)
    try {
      const next = await postVerify({ verified: false })
      // The kill-switch response carries no Postmark record read — keep the
      // records we already have on screen, just flip the flags.
      setState((prev) => ({ ...(prev || {}), ...next, records: prev?.records?.length ? prev.records : next.records }))
    } catch (e) {
      setError(e.message || 'Could not disable sending.')
    } finally {
      setDisabling(false)
    }
  }

  async function copyValue(value) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(value)
      setTimeout(() => setCopiedKey(null), 2000)
    } catch {
      setError('Could not copy — select the value and copy it manually.')
    }
  }

  const verified = !!state?.verified

  return (
    <Card title="Email sending">
      {!provisioned ? (
        <>
          <p className="text-sm text-un1t-subtle">
            Give this host their own sending domain so they can email their
            contact list. The DNS records live in the un1tdublin.com zone —
            you add them after provisioning.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              id="host-email-label"
              label="Subdomain label"
              hint={`Sends from hello@${sanitizeDomainLabel(label) || 'label'}.mail.un1tdublin.com`}
            >
              {(p) => (
                <input
                  {...p}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="acme-events"
                  className={INPUT_CLASS}
                />
              )}
            </Field>
            <Field id="host-email-sender-name" label="Sender name" hint="The From name recipients see.">
              {(p) => (
                <input
                  {...p}
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  placeholder={host?.name || 'Acme Events'}
                  className={INPUT_CLASS}
                />
              )}
            </Field>
          </div>
          <div className="mt-4">
            <Button type="button" icon={Mail} loading={provisioning} onClick={provision}>
              Provision sending domain
            </Button>
          </div>
        </>
      ) : stateLoading ? (
        <p className="text-sm text-un1t-muted">Loading sending domain…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-un1t-bg border border-un1t-border px-2 py-1 font-mono text-xs text-un1t-text">
              {state?.sender_email || state?.domain || host?.sender_email || host?.sender_domain}
            </code>
            {/* Light-theme chip recipe (bg-<c>-500/10 text-<c>-700) — the only one check:guardrails accepts. */}
            <span
              className={
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ' +
                (verified ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700')
              }
            >
              {verified ? <Check size={12} /> : <AlertTriangle size={12} />}
              {verified ? 'Verified — sending enabled' : 'Not verified — sending blocked'}
            </span>
          </div>

          {(state?.records || []).length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-un1t-muted">
                Add these records to the un1tdublin.com DNS zone, then hit Verify.
              </p>
              {state.records.map((r) => (
                <div key={`${r.purpose}-${r.name}`} className="rounded-lg border border-un1t-border bg-un1t-surface p-3 space-y-2">
                  <p className="text-xs font-medium text-un1t-text">
                    {r.purpose} <span className="text-un1t-muted">({r.type})</span>
                  </p>
                  <CopyValue label="Name" value={r.name} copiedKey={copiedKey} onCopy={copyValue} />
                  <CopyValue label="Value" value={r.value} copiedKey={copiedKey} onCopy={copyValue} />
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" icon={RefreshCw} loading={verifying} onClick={verify}>
              Verify
            </Button>
            {verified && (
              <Button type="button" variant="danger" size="sm" loading={disabling} onClick={disableSending}>
                Disable sending
              </Button>
            )}
          </div>
          {state?.slug && (
            <p className="mt-3 text-xs text-un1t-muted">
              Mailing-list signup page: <code className="font-mono">/h/{state.slug}</code>
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 text-xs text-stage-lost flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
    </Card>
  )
}

export default function HostDetail({ hostId }) {
  const [host, setHost] = useState(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false) // ?stripe=return sync-on-load
  const [loadError, setLoadError] = useState(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [feeEuros, setFeeEuros] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [actionError, setActionError] = useState(null)

  // Self-serve onboarding link the operator sends to the host (EVENTS-HOST.5).
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkUrl, setLinkUrl] = useState(null)
  const [linkError, setLinkError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [sendingLink, setSendingLink] = useState(false)
  const [linkSentTo, setLinkSentTo] = useState(null)
  const [invitingPortal, setInvitingPortal] = useState(false)
  const [portalInvitedTo, setPortalInvitedTo] = useState(null)
  const [portalError, setPortalError] = useState(null)
  const [openingPortal, setOpeningPortal] = useState(false)
  const [openPortalError, setOpenPortalError] = useState(null)

  // Portal members linked to this host — invited member logins (HOST-PORTAL.14)
  // and linked UN1T staff logins (HOST-PORTAL.5). GET /link-staff lists ALL
  // host_users rows, so both kinds land in the same list.
  const [staffLinks, setStaffLinks] = useState([])
  const [staffLinkEmail, setStaffLinkEmail] = useState('')
  const [staffLinkError, setStaffLinkError] = useState(null)
  const [staffLinkBusy, setStaffLinkBusy] = useState(false)

  // Invite another member (HOST-PORTAL.14) — a second (or third…) portal login
  // for this host on a different email. Same invite route, explicit { email }.
  const [memberEmail, setMemberEmail] = useState('')
  const [invitingMember, setInvitingMember] = useState(false)
  const [memberInvitedTo, setMemberInvitedTo] = useState(null)
  const [memberError, setMemberError] = useState(null)

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const [revenue, setRevenue] = useState(null)
  const [revenueLoading, setRevenueLoading] = useState(true)

  // Hydrate the editable form from a freshly-loaded host row.
  const applyHost = useCallback((h) => {
    setHost(h)
    setName(h.name || '')
    setEmail(h.email || '')
    setFeeEuros(centsToEuroInput(h.platform_fee_cents))
  }, [])

  const loadHost = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      applyHost(j.data)
    } catch (e) {
      setLoadError(e.message || 'Failed to load host')
    } finally {
      setLoading(false)
    }
  }, [hostId, applyHost])

  // POST .../stripe/sync — re-pulls live status from Stripe. `initial`
  // is the on-return path (shows the "Checking your Stripe status…"
  // full state); otherwise it's the manual "Refresh status" button.
  const syncHost = useCallback(async ({ initial = false } = {}) => {
    setActionError(null)
    if (initial) { setChecking(true); setLoading(true) } else { setSyncing(true) }
    try {
      const res = await fetch(`/api/hosts/${hostId}/stripe/sync`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      applyHost(j.data)
    } catch (e) {
      if (initial) setLoadError(e.message || 'Failed to check Stripe status')
      else setActionError(e.message || 'Failed to refresh Stripe status')
    } finally {
      setChecking(false)
      setSyncing(false)
      setLoading(false)
    }
  }, [hostId, applyHost])

  // On mount: if Stripe bounced the operator back with ?stripe=return,
  // sync first; otherwise just load. Strip the flag so a refresh is a
  // plain load, not another sync.
  useEffect(() => {
    let returned = false
    try {
      const params = new URLSearchParams(window.location.search)
      returned = params.get('stripe') === 'return'
    } catch { /* no window search — treat as normal load */ }
    if (returned) {
      try { window.history.replaceState(null, '', window.location.pathname) } catch { /* ignore */ }
      syncHost({ initial: true })
    } else {
      loadHost()
    }
    // loadHost / syncHost are stable (useCallback keyed on hostId), so this
    // runs once per host — the intended mount behaviour.
  }, [loadHost, syncHost])

  // Revenue loads independently of the host profile — a slow aggregation
  // shouldn't hold up the rest of the page, and a failure is non-fatal.
  useEffect(() => {
    let alive = true
    setRevenueLoading(true)
    fetch(`/api/hosts/${hostId}/revenue`)
      .then((r) => r.json())
      .then((j) => { if (alive && j?.success) setRevenue(j.data) })
      .catch(() => { /* non-fatal — the card just stays empty */ })
      .finally(() => { if (alive) setRevenueLoading(false) })
    return () => { alive = false }
  }, [hostId])

  // Portal members load independently — a failure is non-fatal (the
  // subsection just shows "No portal members yet."). Keyed on hostId.
  const loadStaffLinks = useCallback(async () => {
    try {
      const res = await fetch(`/api/hosts/${hostId}/link-staff`)
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.success) setStaffLinks(Array.isArray(j.data) ? j.data : [])
    } catch { /* non-fatal — leave the current list in place */ }
  }, [hostId])

  useEffect(() => { loadStaffLinks() }, [loadStaffLinks])

  async function save(e) {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
          platform_fee_cents: euroInputToCents(feeEuros),
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      applyHost(j.data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setSaveError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function connect() {
    if (connecting) return
    setConnecting(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/stripe/connect`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success || !j.data?.url) throw new Error(j.error || `HTTP ${res.status}`)
      // Hand the browser to Stripe's hosted onboarding. Stripe returns to
      // /settings/hosts/<id>?stripe=return, which the mount effect syncs.
      window.location.href = j.data.url
    } catch (err) {
      setActionError(err.message || 'Failed to start Stripe onboarding')
      setConnecting(false)
    }
  }

  // Mint the secure self-serve link. The host opens it with no login and
  // connects their own Stripe account; we reveal it for the operator to copy.
  async function getOnboardingLink() {
    if (linkLoading) return
    setLinkLoading(true)
    setLinkError(null)
    setCopied(false)
    try {
      const res = await fetch(`/api/hosts/${hostId}/onboarding-link`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success || !j.data?.url) throw new Error(j.error || `HTTP ${res.status}`)
      setLinkUrl(j.data.url)
    } catch (err) {
      setLinkError(err.message || 'Failed to create onboarding link')
    } finally {
      setLinkLoading(false)
    }
  }

  async function copyLink() {
    if (!linkUrl) return
    try {
      await navigator.clipboard.writeText(linkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setLinkError('Could not copy — select the link and copy it manually.')
    }
  }

  // Email the onboarding link straight to the host (server mints a fresh token
  // + sends). Only offered when the host has an email on file.
  async function emailOnboardingLink() {
    if (sendingLink) return
    setSendingLink(true)
    setLinkError(null)
    setLinkSentTo(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/onboarding-link/send`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setLinkSentTo(j.data?.sentTo || host?.email || 'the host')
      setTimeout(() => setLinkSentTo(null), 4000)
    } catch (err) {
      setLinkError(err.message || 'Could not email the link')
    } finally {
      setSendingLink(false)
    }
  }

  // Invite the host to their self-serve portal — creates/links a login and
  // emails them a set-password link. (HOST-PORTAL.1)
  async function inviteToPortal() {
    if (invitingPortal) return
    setInvitingPortal(true)
    setPortalError(null)
    setPortalInvitedTo(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/invite`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setPortalInvitedTo(j.data?.sentTo || host?.email || 'the host')
      setTimeout(() => setPortalInvitedTo(null), 5000)
      // A fresh invite creates a host_users row — reflect it in Portal members.
      loadStaffLinks()
    } catch (err) {
      setPortalError(err.message || 'Could not send the portal invite')
    } finally {
      setInvitingPortal(false)
    }
  }

  // Invite an additional portal member on their own email (HOST-PORTAL.14).
  // Same route as "Invite to portal", with an explicit { email } body.
  async function inviteMember() {
    const email = memberEmail.trim()
    if (!email || invitingMember) return
    setInvitingMember(true)
    setMemberError(null)
    setMemberInvitedTo(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setMemberInvitedTo(j.data?.sentTo || email)
      setTimeout(() => setMemberInvitedTo(null), 5000)
      setMemberEmail('')
      await loadStaffLinks()
    } catch (err) {
      setMemberError(err.message || 'Could not send the invite')
    } finally {
      setInvitingMember(false)
    }
  }

  // Open this host's portal as the admin ("view-as", HOST-PORTAL.4). Starts a
  // server-side impersonation session (sets a cookie), then does a FULL
  // navigation so the new cookie rides along on the /host request. The admin
  // exits back to the CRM via the banner inside the portal — not sign-out.
  async function openPortal() {
    if (openingPortal) return
    setOpeningPortal(true)
    setOpenPortalError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/impersonate`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      // Full navigation (not router.push) so the freshly-set cookie is sent.
      window.location.href = '/host'
    } catch (err) {
      setOpenPortalError(err.message || 'Could not open the host portal')
      setOpeningPortal(false)
    }
  }

  // Remove the host. Events assigned to them fall back to internal/UN1T
  // (Revolut) via ON DELETE SET NULL — the host's own Stripe account is
  // untouched. On success we bounce back to the hosts list.
  async function handleDelete() {
    if (deleting) return
    const label = name.trim() || 'this host'
    if (!window.confirm(
      `Delete ${label}?\n\nAny events currently assigned to them will switch back to UN1T (settled via Revolut). Their Stripe account is not affected — this only removes the payee record here.`
    )) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      window.location.href = '/settings/hosts'
    } catch (e) {
      setDeleting(false)
      setDeleteError(e.message || 'Could not delete host')
    }
  }

  // Link an existing UN1T staff login to this host (HOST-PORTAL.5). On success
  // clear the input + error and refresh the list; the API returns a friendly
  // { error } for not-staff / cross-org / already-linked-elsewhere cases.
  async function linkStaff() {
    const email = staffLinkEmail.trim()
    if (!email || staffLinkBusy) return
    setStaffLinkBusy(true)
    setStaffLinkError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/link-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setStaffLinkEmail('')
      setStaffLinkError(null)
      await loadStaffLinks()
    } catch (err) {
      setStaffLinkError(err.message || 'Could not link that staff login.')
    } finally {
      setStaffLinkBusy(false)
    }
  }

  async function unlinkStaff(authUserId) {
    setStaffLinkError(null)
    try {
      const res = await fetch(`/api/hosts/${hostId}/link-staff`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_user_id: authUserId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      await loadStaffLinks()
    } catch (err) {
      setStaffLinkError(err.message || 'Could not unlink.')
    }
  }

  if (loading) {
    return <Loading label={checking ? 'Checking your Stripe status…' : 'Loading host…'} />
  }

  if (loadError || !host) {
    return (
      <Card>
        <p className="text-sm text-stage-lost flex items-center gap-1">
          <AlertTriangle size={14} /> {loadError || 'Host not found.'}
        </p>
        <Button variant="secondary" size="sm" onClick={loadHost} className="mt-3">Retry</Button>
      </Card>
    )
  }

  const isStripe = host.payment_provider === PROVIDER_STRIPE_CONNECT
  const ready = hostCanTakePayments(host)
  const hasAccount = !!host.stripe_connected_account_id

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Store size={20} className="text-un1t-subtle" />
        <h2 className="text-2xl font-bold">{host.name}</h2>
      </div>

      {/* Payments status */}
      <Card title="Payments">
        {!isStripe ? (
          <p className="text-sm text-un1t-subtle">
            This host settles via Revolut (an internal UN1T payout route) — no Stripe onboarding needed.
          </p>
        ) : ready ? (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
            <p className="text-sm font-medium text-green-700 flex items-center gap-1.5">
              <Check size={16} /> This host can take payments
            </p>
            <p className="mt-1 text-xs text-green-700/80">
              Stripe onboarding is complete. Their events will settle to their connected account, with the
              booking fee kept per ticket.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-700 flex items-center gap-1.5">
              <AlertTriangle size={16} /> Finish Stripe onboarding
            </p>
            <p className="mt-1 text-xs text-amber-700/80">
              {hasAccount
                ? 'Stripe still needs more details before this host can take payments. Continue where they left off.'
                : 'Connect this host to Stripe so their event tickets settle to their own account.'}
            </p>
          </div>
        )}

        {isStripe && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusFlag ok={!!host.charges_enabled} label="Charges enabled" />
              <StatusFlag ok={!!host.payouts_enabled} label="Payouts enabled" />
              <StatusFlag ok={!!host.details_submitted} label="Details submitted" />
              {host?.stripe_connected_account_id && (
                <a
                  href={`https://dashboard.stripe.com/connect/accounts/${host.stripe_connected_account_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
                >
                  View in Stripe <ExternalLink size={10} />
                </a>
              )}
            </div>

            {actionError && (
              <p className="mt-3 text-xs text-stage-lost flex items-center gap-1">
                <AlertTriangle size={12} /> {actionError}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!ready && (
                <Button icon={CreditCard} loading={connecting} onClick={connect}>
                  {hasAccount ? 'Continue Stripe onboarding' : 'Connect with Stripe'}
                  {!connecting && <ExternalLink size={12} className="opacity-70" />}
                </Button>
              )}
              {!ready && (
                <Button
                  variant="secondary"
                  icon={Link2}
                  loading={linkLoading}
                  onClick={getOnboardingLink}
                >
                  Get onboarding link for the host
                </Button>
              )}
              {!ready && host?.email && (
                <Button
                  variant="secondary"
                  icon={Mail}
                  loading={sendingLink}
                  onClick={emailOnboardingLink}
                >
                  Email link to host
                </Button>
              )}
              {hasAccount && (
                <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={() => syncHost()}>
                  Refresh status
                </Button>
              )}
            </div>

            {linkSentTo && (
              <p className="mt-3 text-xs text-green-700 flex items-center gap-1">
                <Check size={12} /> Onboarding link emailed to {linkSentTo}.
              </p>
            )}

            {linkError && (
              <p className="mt-3 text-xs text-stage-lost flex items-center gap-1">
                <AlertTriangle size={12} /> {linkError}
              </p>
            )}

            {linkUrl && (
              <div className="mt-4 rounded-lg border border-un1t-border bg-un1t-bg p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    readOnly
                    value={linkUrl}
                    onFocus={(e) => e.target.select()}
                    aria-label="Host onboarding link"
                    className={`${INPUT_CLASS} font-mono text-xs`}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copied ? Check : Copy}
                    onClick={copyLink}
                    className="shrink-0"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-un1t-subtle">
                  Send this to the host — they open it and connect their own Stripe account, no login needed.
                </p>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Revenue rollup (EVENTS-HOST.8) */}
      <Card title="Revenue">
        {revenueLoading ? (
          <p className="text-sm text-un1t-muted">Loading revenue…</p>
        ) : !revenue || revenue.totals.paidCount === 0 ? (
          <p className="text-sm text-un1t-muted">No ticket sales yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Gross collected" value={fmtEuro(revenue.totals.gross_cents, revenue.currency)} />
              <Stat label="UN1T booking fees" value={fmtEuro(revenue.totals.fee_cents, revenue.currency)} />
              <Stat label="Net to host" value={fmtEuro(revenue.totals.net_to_host_cents, revenue.currency)} />
              <Stat label="Refunded" value={fmtEuro(revenue.totals.refunded_cents, revenue.currency)} />
            </div>
            <p className="mt-2 text-xs text-un1t-muted">
              {revenue.totals.paidCount} paid {revenue.totals.paidCount === 1 ? 'ticket' : 'tickets'}
              {' · '}net collected after refunds {fmtEuro(revenue.totals.net_collected_cents, revenue.currency)}
            </p>
            {revenue.perEvent.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-un1t-muted border-b border-un1t-border">
                      <th className="py-2 pr-3 font-medium">Event</th>
                      <th className="py-2 px-3 font-medium text-right">Tickets</th>
                      <th className="py-2 px-3 font-medium text-right">Gross</th>
                      <th className="py-2 px-3 font-medium text-right">Fee</th>
                      <th className="py-2 pl-3 font-medium text-right">Net to host</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.perEvent.map((e) => (
                      <tr key={e.event_id} className="border-b border-un1t-border/50">
                        <td className="py-2 pr-3">{e.name}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{e.paidCount}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtEuro(e.gross_cents, revenue.currency)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtEuro(e.fee_cents, revenue.currency)}</td>
                        <td className="py-2 pl-3 text-right tabular-nums">{fmtEuro(e.net_to_host_cents, revenue.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Editable profile */}
      <Card title="Host details">
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="edit-host-name" label="Name" required>
              {(p) => (
                <input
                  {...p}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={INPUT_CLASS}
                />
              )}
            </Field>
            <Field id="edit-host-email" label="Email" hint="Where Stripe sends onboarding + payout notices.">
              {(p) => (
                <input
                  {...p}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="organiser@example.com"
                  className={INPUT_CLASS}
                />
              )}
            </Field>
          </div>
          <Field
            id="edit-host-fee"
            label="Booking fee per ticket (€)"
            hint="UN1T keeps this on every ticket the host sells. Leave blank for no fee."
            className="sm:max-w-xs"
          >
            {(p) => (
              <input
                {...p}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={feeEuros}
                onChange={(e) => setFeeEuros(e.target.value)}
                placeholder="0.00"
                className={INPUT_CLASS}
              />
            )}
          </Field>
          {saveError && (
            <p className="text-xs text-stage-lost flex items-center gap-1">
              <AlertTriangle size={12} /> {saveError}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" icon={Save} loading={saving} disabled={!name.trim()}>
              Save changes
            </Button>
            {saved && <span className="text-xs text-green-700">Saved.</span>}
          </div>
        </form>
      </Card>

      {/* Email sending (HOST-EMAIL.2) — the host's dedicated Postmark sending
          domain: provision, DNS records, verification, kill switch. Keyed on
          the domain id so a fresh provision remounts with the new state. */}
      <EmailSendingCard key={host.postmark_domain_id || 'unprovisioned'} hostId={hostId} host={host} />

      {/* Sender defaults (HOST-EMAIL.5) — from-address, sender name, reply-to. */}
      <SenderDefaultsCard
        key={`sender-${host.sender_email || ''}-${host.reply_to_email || ''}-${host.postmark_stream_id || ''}`}
        hostId={hostId}
        host={host}
        applyHost={applyHost}
      />

      {/* Host portal access (HOST-PORTAL.1) — give the host a login to their
          own self-serve dashboard. Emails them a set-password link. */}
      <Card title="Host portal">
        <p className="text-sm text-un1t-subtle">
          Give this host a login to their own portal — their events, revenue,
          and attendees. We email them a link to set a password.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            icon={ExternalLink}
            loading={openingPortal}
            onClick={openPortal}
          >
            Open host portal
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon={Mail}
            loading={invitingPortal}
            onClick={inviteToPortal}
            disabled={!host?.email}
          >
            Invite to portal
          </Button>
          {!host?.email && <span className="text-xs text-un1t-muted">Add an email above first.</span>}
          {portalInvitedTo && (
            <span className="text-xs text-green-700 inline-flex items-center gap-1">
              <Check size={12} /> Invite sent to {portalInvitedTo}.
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-un1t-muted">
          Opens this host&apos;s portal as you (admin) — you can exit back to the CRM anytime.
        </p>
        {openPortalError && (
          <p className="mt-2 text-xs text-stage-lost flex items-center gap-1">
            <AlertTriangle size={12} /> {openPortalError}
          </p>
        )}
        {portalError && (
          <p className="mt-2 text-xs text-stage-lost flex items-center gap-1">
            <AlertTriangle size={12} /> {portalError}
          </p>
        )}

        {/* Portal members — everyone with a login to this host's portal:
            invited member logins (HOST-PORTAL.1/.14) and linked UN1T staff
            logins (HOST-PORTAL.5). Backed by GET/DELETE /link-staff, which
            lists/unlinks ALL host_users rows for the host. */}
        <div className="mt-4 pt-4 border-t border-un1t-border">
          <p className="text-sm font-medium text-un1t-text">Portal members</p>
          <p className="mt-1 text-xs text-un1t-muted">
            Everyone who can sign in to this host&apos;s portal — invited members and linked UN1T staff logins.
          </p>

          <div className="mt-3 space-y-2">
            {staffLinks.length === 0 ? (
              <p className="text-xs text-un1t-muted">No portal members yet.</p>
            ) : (
              staffLinks.map((link) => (
                <div
                  key={link.auth_user_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-un1t-text">{link.full_name || link.email}</p>
                    {link.full_name && (
                      <p className="truncate text-xs text-un1t-muted">{link.email}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => unlinkStaff(link.auth_user_id)}
                    className="shrink-0"
                  >
                    Unlink
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* Invite another member (HOST-PORTAL.14) — a second (or third…)
              login for this host on a different email, e.g. a co-organiser. */}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="email"
              value={memberEmail}
              onChange={(e) => setMemberEmail(e.target.value)}
              placeholder="co-organiser@example.com"
              aria-label="Email to invite as a portal member"
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="secondary"
              icon={Mail}
              loading={invitingMember}
              onClick={inviteMember}
              className="shrink-0"
            >
              Invite member
            </Button>
          </div>
          {memberInvitedTo && (
            <p className="mt-2 text-xs text-green-700 inline-flex items-center gap-1">
              <Check size={12} /> Invite sent to {memberInvitedTo}.
            </p>
          )}
          {memberError && (
            <p className="mt-2 text-xs text-stage-lost flex items-center gap-1">
              <AlertTriangle size={12} /> {memberError}
            </p>
          )}

          {/* Link staff (HOST-PORTAL.5) — an existing UN1T staff member who is
              also this host, accessing the portal with their normal login. */}
          <p className="mt-4 text-xs text-un1t-muted">
            Or give an existing UN1T staff member access with their normal login:
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="email"
              value={staffLinkEmail}
              onChange={(e) => setStaffLinkEmail(e.target.value)}
              placeholder="staff@un1tdublin.com"
              aria-label="Staff email to link"
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="secondary"
              icon={Link2}
              loading={staffLinkBusy}
              onClick={linkStaff}
              className="shrink-0"
            >
              Link staff login
            </Button>
          </div>

          {staffLinkError && (
            <p className="mt-2 text-xs text-stage-lost flex items-center gap-1">
              <AlertTriangle size={12} /> {staffLinkError}
            </p>
          )}
        </div>
      </Card>

      {/* Danger zone — a separate card so a delete can't be fat-fingered next
          to Save. Deleting only drops our payee record; assigned events revert
          to UN1T (Revolut) via ON DELETE SET NULL and the host keeps their own
          Stripe account. */}
      <Card title="Danger zone">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-un1t-text">Delete this host</p>
            <p className="mt-1 text-xs text-un1t-muted">
              Removes the payee record here. Any events assigned to this host
              switch back to UN1T (settled via Revolut). Their Stripe account
              isn&apos;t affected.
            </p>
            {deleteError && (
              <p className="mt-2 text-xs text-stage-lost flex items-center gap-1">
                <AlertTriangle size={12} /> {deleteError}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="danger"
            size="sm"
            icon={Trash2}
            loading={deleting}
            onClick={handleDelete}
          >
            Delete host
          </Button>
        </div>
      </Card>
    </div>
  )
}
