'use client'

// HostConnect — the self-serve Stripe onboarding client for an event host
// (EVENTS-HOST.5). Fetches the host's status by the signed token in the URL and
// walks them through connecting their OWN Stripe account with no login.
//
// Flow:
//   1. On mount: GET /api/public/host-connect/[token]. If Stripe bounced the
//      host back with ?done=1, strip the flag (so a refresh is a plain load)
//      and re-fetch — the account status may have just changed.
//   2. charges_enabled === true → "you're all set" success card, no button.
//   3. otherwise → the connect card. The button POSTs .../start and redirects
//      the browser to Stripe's hosted onboarding (data.url). If the host has a
//      connected account but hasn't finished, the button becomes "Finish Stripe
//      setup" and we nudge them to pick up where they left off.
//
// Standalone dark UN1T brand (bg-black + lp-* tokens), matching the event
// reskin — this is the host's view, never the CRM shell.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertCircle, ArrowRight, Check, Minus } from 'lucide-react'

// One onboarding-status flag as a small dark pill. The accent lives on the icon
// (a separate className) so this file never pairs a bg-*-500/10 tint with a
// low text ramp — the light-theme chip-contrast guardrail stays green here.
function StatusPill({ ok, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/70">
      {ok
        ? <Check size={13} className="text-emerald-400" />
        : <Minus size={13} className="text-white/30" />}
      {label}
    </span>
  )
}

export default function HostConnect({ token }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/public/host-connect/${token}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setStatus(j.data)
    } catch (e) {
      setLoadError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [token])

  // On mount: if Stripe returned the host with ?done=1, strip the flag so a
  // refresh doesn't re-trigger, then load (status may have just changed).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('done') === '1') {
        window.history.replaceState(null, '', window.location.pathname)
      }
    } catch { /* no window search — treat as a plain load */ }
    load()
  }, [load])

  const start = useCallback(async () => {
    if (starting) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await fetch(`/api/public/host-connect/${token}/start`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success || !j.data?.url) throw new Error(j.error || `HTTP ${res.status}`)
      // Hand the browser to Stripe's hosted onboarding. Stripe returns to
      // /host-connect/[token]?done=1, which the mount effect re-loads.
      window.location.href = j.data.url
    } catch (e) {
      setStartError(e.message || 'Could not start Stripe onboarding. Please try again.')
      setStarting(false)
    }
  }, [token, starting])

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <Loader2 size={28} className="animate-spin text-white/40" />
      </div>
    )
  }

  // ── Invalid / expired token ──────────────────────────────────────────────
  if (loadError || !status) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="lp-card-glow rounded-2xl p-8 max-w-sm text-center">
          <AlertCircle size={32} className="mx-auto text-red-400 mb-4" />
          <p className="text-white/70 leading-relaxed">
            This link is invalid or has expired — ask UN1T for a new one.
          </p>
        </div>
      </div>
    )
  }

  const name = status.name || 'Your account'
  const isReady = status.charges_enabled === true
  const started = status.connected === true

  // ── Connected & live ─────────────────────────────────────────────────────
  if (isReady) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center px-4 py-14">
        <div className="w-full max-w-md">
          <div className="text-center mb-7">
            <div className="w-[60px] h-[60px] mx-auto mb-5 rounded-full grid place-items-center bg-emerald-500/10 border border-emerald-500/30">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                <path className="lp-check-path" d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold">
              Stripe connected
            </p>
            <h1 className="text-3xl font-bold uppercase tracking-tight mt-3">You&apos;re all set</h1>
          </div>

          <div className="lp-card-glow rounded-2xl p-6 text-center">
            <p className="text-white/70 leading-relaxed">
              <strong className="text-white font-semibold">{name}</strong> — your Stripe account is
              connected and you can get paid for your events.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <StatusPill ok={status.charges_enabled} label="Charges" />
              <StatusPill ok={status.payouts_enabled} label="Payouts" />
              <StatusPill ok={status.details_submitted} label="Details" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Not connected yet (or started but unfinished) ────────────────────────
  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center px-4 py-14">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold">
            Get paid for your events
          </p>
          <h1 className="text-3xl font-bold uppercase tracking-tight mt-3">{name} × UN1T</h1>
        </div>

        <div className="lp-card-glow rounded-2xl p-6">
          <p className="text-sm text-white/70 leading-relaxed">
            Connect your Stripe account so your event ticket sales are paid directly to you.
          </p>

          {started && (
            <p className="mt-4 rounded-xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-[13px] text-amber-200 leading-relaxed">
              You started but haven&apos;t finished — pick up where you left off.
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <StatusPill ok={status.charges_enabled} label="Charges" />
            <StatusPill ok={status.payouts_enabled} label="Payouts" />
            <StatusPill ok={status.details_submitted} label="Details" />
          </div>

          {startError && (
            <div className="mt-5 p-3 bg-red-500/10 border border-red-500/30 text-red-200 text-sm rounded-lg flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {startError}
            </div>
          )}

          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="lp-btn w-full mt-6 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {starting ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : null}
            {started ? 'Finish Stripe setup' : 'Connect with Stripe'}
            {!starting && <ArrowRight size={16} className="lp-btn-arrow" aria-hidden="true" />}
          </button>

          <p className="mt-4 text-center text-[11px] uppercase tracking-[0.16em] text-white/40">
            Secure onboarding by Stripe
          </p>
        </div>
      </div>
    </div>
  )
}
