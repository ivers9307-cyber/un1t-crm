'use client'

// PaymentsIntegrationTab — per-location payment rail for the class funnel
// (PAID-INTRO-P3C.4). Writes locations.settings.payments =
// { provider, stripe_connected_account_id }.
//
// Revolut = UN1T is the merchant on the intro-offer charge (works out of
// the box, no extra setup). Stripe = a direct charge on THIS location's
// own Stripe Connect account — onboarding must finish (charges_enabled)
// before the location can be switched over. Follows the same
// read-merge-write-into-locations.settings pattern as GlofoxIntegrationTab
// and TwilioIntegrationTab.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Save, Loader2, Check, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react'

export default function PaymentsIntegrationTab({ location, canEdit }) {
  const router = useRouter()
  const initial = location.settings?.payments || {}
  const hasStripeAccount = !!initial.stripe_connected_account_id

  const [provider, setProvider] = useState(initial.provider || 'revolut')
  const [status, setStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  useEffect(() => {
    if (!hasStripeAccount) return
    let cancelled = false
    async function load() {
      setStatusLoading(true)
      try {
        const r = await fetch(`/api/locations/${location.id}/stripe-connect/status`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!cancelled && r.ok && j.success) setStatus(j.data)
      } catch {
        // Silently ignore — the tab just shows what it has stored.
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [location.id, hasStripeAccount])

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    if (provider === 'stripe_connect' && !status?.charges_enabled) {
      setError('Finish Stripe onboarding (charges must be enabled) before switching this location to Stripe.')
      setSaving(false)
      return
    }
    const db = createBrowserClient()
    // Re-read current settings so we merge rather than clobber any
    // other tab's slice.
    const { data: row, error: readErr } = await db
      .from('locations').select('settings').eq('id', location.id).single()
    if (readErr) { setError(readErr.message); setSaving(false); return }
    const prevPayments = row?.settings?.payments || {}
    const nextSettings = {
      ...(row?.settings || {}),
      payments: { ...prevPayments, provider },
    }
    const { error: upErr } = await db
      .from('locations')
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq('id', location.id)
    setSaving(false)
    if (upErr) { setError(upErr.message); return }
    setSavedAt(new Date())
    router.refresh()
  }

  async function connectStripe() {
    setConnecting(true); setError(null)
    try {
      const r = await fetch(`/api/locations/${location.id}/stripe-connect/connect`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not start Stripe onboarding')
      window.open(j.data.url, '_blank', 'noopener')
    } catch (e) {
      setError(e.message)
    } finally {
      setConnecting(false)
    }
  }

  async function refreshStatus() {
    setStatusLoading(true)
    try {
      const r = await fetch(`/api/locations/${location.id}/stripe-connect/status`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (j?.success) setStatus(j.data)
    } catch {
      // Silently ignore.
    } finally {
      setStatusLoading(false)
    }
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-subtle">
        Only owners + masters can edit payment settings.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Which processor takes the class-funnel intro payment for this location. Revolut
        charges to the UN1T merchant account and needs no extra setup. Stripe charges
        directly to this location&apos;s own connected account — onboarding must be finished
        (charges enabled) before it can be selected below.
      </p>

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

      <div>
        <label className="block text-xs text-un1t-subtle mb-1">Payment rail</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="w-full max-w-xs bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="revolut">Revolut (UN1T)</option>
          <option value="stripe_connect">Stripe (this location)</option>
        </select>
      </div>

      {provider === 'stripe_connect' && (
        <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
          <div className="text-sm font-semibold text-un1t-text">Stripe Connect</div>
          <div className="text-[11px] text-un1t-muted">
            {status?.charges_enabled
              ? 'Ready — charges enabled.'
              : hasStripeAccount
                ? 'Onboarding not finished — charges not yet enabled.'
                : 'Not connected yet.'}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={connectStripe}
              disabled={connecting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {connecting
                ? <><Loader2 size={12} className="animate-spin" /> Opening…</>
                : <><ExternalLink size={12} /> {hasStripeAccount ? 'Finish setup' : 'Connect Stripe'}</>
              }
            </button>
            {hasStripeAccount && (
              <button
                type="button"
                onClick={refreshStatus}
                disabled={statusLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-un1t-border text-un1t-subtle text-sm hover:text-un1t-text disabled:opacity-50"
              >
                {statusLoading
                  ? <><Loader2 size={12} className="animate-spin" /> Checking…</>
                  : <><RefreshCw size={12} /> Refresh status</>
                }
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end pt-2 border-t border-un1t-border/40">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving
            ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
            : <><Save size={12} /> Save</>
          }
        </button>
      </div>
    </div>
  )
}
