'use client'

// INTEG-B3 — the multi-step email-domain wizard on /settings/email-domain.
// Server-per-tenant sending domain. Steps flow off the redacted status
// payload from GET/POST /api/settings/email-domain:
//   1. add-on gate / upsell   — plan doesn't include custom_email_domain
//   2. enter domain            — status 'not_configured'
//   3. DNS records + verify    — status 'pending' / 'verifying' / 'failed'
//   4. live                    — status 'live'
// The server token is NEVER part of the payload — this component only ever
// sees the DNS records + verification booleans.

import { useState } from 'react'
import { CheckCircle2, Clock, Copy, Check, AlertTriangle, Lock } from 'lucide-react'

// Light-theme chip recipe (bg-*-500/10 + -700 text) per the guardrails lint.
const STATUS_CHIP = {
  live: { label: 'Live', className: 'bg-green-500/10 text-green-700' },
  verifying: { label: 'Verifying', className: 'bg-amber-500/10 text-amber-700' },
  pending: { label: 'Pending', className: 'bg-amber-500/10 text-amber-700' },
  failed: { label: 'Failed', className: 'bg-red-500/10 text-red-700' },
  disabled: { label: 'Disabled', className: 'bg-un1t-border text-un1t-subtle' },
  not_configured: { label: 'Not set up', className: 'bg-un1t-border text-un1t-subtle' },
}

function orgQuery(organizationId) {
  return organizationId ? `?organization_id=${encodeURIComponent(organizationId)}` : ''
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard unavailable */ }
      }}
      className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text shrink-0"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check size={13} className="text-green-700" /> : <Copy size={13} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function RecordVerifiedChip({ verified }) {
  const chip = verified
    ? { label: 'Verified', className: 'bg-green-500/10 text-green-700', Icon: CheckCircle2 }
    : { label: 'Pending', className: 'bg-amber-500/10 text-amber-700', Icon: Clock }
  const { Icon } = chip
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${chip.className}`}>
      <Icon size={12} /> {chip.label}
    </span>
  )
}

export default function EmailDomainWizard({ initialState, organizationId }) {
  const [state, setState] = useState(initialState)
  const [domain, setDomain] = useState('')
  const [fromLocal, setFromLocal] = useState('hello')
  const [fromName, setFromName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const q = orgQuery(organizationId)

  async function post(path, extraBody) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(organizationId ? { organization_id: organizationId } : {}), ...(extraBody || {}) }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'Something went wrong.')
        return false
      }
      setState(json.data)
      return true
    } catch {
      setError('Network error — please try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  // ── 1. Not configured on this deployment (no account token) ────────
  if (!state.account_configured) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-sm text-un1t-subtle">
        Email domain provisioning isn&apos;t configured on this deployment yet. Contact support to enable it.
      </div>
    )
  }

  // ── 2. Add-on gate / upsell ────────────────────────────────────────
  if (!state.addon_active) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-2">
          <Lock size={16} className="text-un1t-subtle" />
          <h2 className="text-base font-semibold">Custom email domain add-on</h2>
        </div>
        <p className="text-sm text-un1t-subtle mb-4">
          Send from your own verified domain (e.g. hello@mail.yourgym.com) on a dedicated Postmark
          server — your own sender reputation, streams and analytics, separate from every other
          tenant. This is a paid add-on that isn&apos;t on your current plan.
        </p>
        <p className="text-sm text-un1t-subtle">
          Talk to us to enable the custom email domain add-on for your organisation.
        </p>
      </div>
    )
  }

  const statusChip = STATUS_CHIP[state.status] || STATUS_CHIP.not_configured

  // ── 3. Enter domain (not yet provisioned) ──────────────────────────
  if (state.status === 'not_configured') {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6">
        <h2 className="text-base font-semibold mb-1">Set up your sending domain</h2>
        <p className="text-sm text-un1t-subtle mb-4">
          Enter a subdomain you control (a subdomain like <code className="text-un1t-text">mail.yourgym.com</code>{' '}
          is recommended so it can&apos;t clash with your website records). We&apos;ll create your dedicated
          mail server and give you the DNS records to add.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            await post(`/api/settings/email-domain`, {
              domain: domain.trim(),
              from_local: fromLocal.trim() || 'hello',
              from_name: fromName.trim() || undefined,
            })
          }}
          className="space-y-4 max-w-lg"
        >
          <label className="block text-sm">
            <span className="text-un1t-subtle">Sending domain</span>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="mail.yourgym.com"
              className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
              required
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-un1t-subtle">From address (local part)</span>
              <input
                type="text"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
                placeholder="hello"
                className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-un1t-subtle">From name (optional)</span>
              <input
                type="text"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="Your Gym"
                className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>
          {domain.trim() && (
            <p className="text-xs text-un1t-subtle">
              Mail will send from{' '}
              <code className="text-un1t-text">{(fromLocal.trim() || 'hello')}@{domain.trim()}</code>.
            </p>
          )}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">{error}</div>
          )}
          <button
            type="submit"
            disabled={busy || !domain.trim()}
            className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-lg text-sm font-medium hover:bg-un1t-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create sending domain'}
          </button>
        </form>
      </div>
    )
  }

  // ── 4. Live state ──────────────────────────────────────────────────
  const isLive = state.status === 'live'

  return (
    <div className="space-y-4">
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <div>
            <div className="text-xs text-un1t-subtle uppercase tracking-wide mb-0.5">Sending domain</div>
            <div className="text-lg font-semibold">{state.sending_domain}</div>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${statusChip.className}`}>
            {statusChip.label}
          </span>
        </div>
        {state.from_email && (
          <p className="text-sm text-un1t-subtle">
            From <code className="text-un1t-text">{state.from_name ? `${state.from_name} <${state.from_email}>` : state.from_email}</code>
          </p>
        )}
        {state.last_error && (
          <div className="mt-3 bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{state.last_error}</span>
          </div>
        )}
      </div>

      {isLive ? (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-lg p-4 flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>
            Your domain is verified and live. All of your organisation&apos;s email now sends from
            your own domain on your dedicated mail server.
          </span>
        </div>
      ) : (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-sm rounded-lg p-4">
          Add these records to your domain&apos;s DNS at your registrar, then click Verify. It can take
          a few minutes (occasionally up to an hour) for DNS changes to propagate. Your mail keeps
          sending from the shared domain until this one is verified.
        </div>
      )}

      {/* DNS records */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <div className="text-sm font-medium mb-3">DNS records</div>
        <div className="space-y-3">
          {(state.records || []).map((rec) => (
            <div key={rec.purpose} className="border border-un1t-border rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{rec.purpose}</span>
                  <span className="text-xs bg-un1t-border text-un1t-subtle px-1.5 py-0.5 rounded">{rec.type}</span>
                </div>
                <RecordVerifiedChip
                  verified={rec.purpose === 'DKIM' ? state.dkim_verified : state.return_path_verified}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-un1t-subtle">Name / host</div>
                    <code className="text-xs text-un1t-text break-all">{rec.name}</code>
                  </div>
                  <CopyButton value={rec.name} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-un1t-subtle">Value</div>
                    <code className="text-xs text-un1t-text break-all">{rec.value}</code>
                  </div>
                  <CopyButton value={rec.value} />
                </div>
              </div>
            </div>
          ))}
          {(!state.records || state.records.length === 0) && (
            <p className="text-xs text-un1t-subtle">No DNS records to show yet.</p>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">{error}</div>
      )}

      <button
        type="button"
        onClick={() => post(`/api/settings/email-domain/verify`)}
        disabled={busy}
        className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-lg text-sm font-medium hover:bg-un1t-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Checking…' : isLive ? 'Re-check DNS' : 'Verify'}
      </button>
    </div>
  )
}
