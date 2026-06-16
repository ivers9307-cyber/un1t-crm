'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Zap, AlertCircle, ExternalLink } from 'lucide-react'

export default function AutomationsView({ locationId, locationName, cards }) {
  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-un1t-white">Automations</h1>
        <p className="text-sm text-un1t-light">
          Things that run automatically for {locationName || 'this location'}. Each one is off until you turn it on.
        </p>
      </div>

      {cards.map((card) => (
        <AutomationCard key={card.key} card={card} locationId={locationId} />
      ))}

      <div className="text-xs text-un1t-light border-t border-un1t-gray pt-3">
        See also:{' '}
        <Link href="/communications/sequences" className="underline">Sequences</Link> (message automations) ·{' '}
        <Link href="/settings/customer-agent" className="underline">Mia agent</Link>
      </div>
    </div>
  )
}

function AutomationCard({ card, locationId }) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(card.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const disabled = busy || !card.status.available || !locationId

  async function toggle() {
    const next = !enabled
    setBusy(true); setError(null)
    setEnabled(next)
    try {
      const res = await fetch(`/api/automations/${card.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, enabled: next }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.message || j.error || 'Save failed')
      router.refresh()
    } catch (e) {
      setEnabled(!next)
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-un1t-light" />
            <h2 className="font-semibold text-un1t-white">{card.label}</h2>
          </div>
          <p className="text-sm text-un1t-light mt-1">{card.description}</p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-pressed={enabled}
          className={`shrink-0 inline-flex h-6 w-11 items-center rounded-full transition ${enabled ? 'bg-emerald-500' : 'bg-un1t-gray'} disabled:opacity-40`}
        >
          <span className={`h-5 w-5 rounded-full bg-white transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="mt-3 text-xs">
        {!card.status.available && (
          <p className="text-amber-700">Glofox isn&apos;t connected at this location — connect it in Settings → Locations → Glofox Integration to use this.</p>
        )}
        {card.status.available && !card.status.trialConfigured && (
          <p className="text-amber-700 inline-flex items-center gap-1">
            <AlertCircle size={12} /> No trial membership set — accounts will be created without a trial.{' '}
            <Link href="/settings" className="underline">Set it</Link>
          </p>
        )}
        {card.status.available && card.status.trialConfigured && (
          <p className="text-emerald-700">Glofox connected · trial configured ✓</p>
        )}
      </div>

      {busy && <p className="mt-2 text-[11px] text-un1t-light inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Saving…</p>}
      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      <div className="mt-3 border-t border-un1t-gray/60 pt-2">
        <Link href={card.reviewBase} className="text-[11px] text-un1t-light underline inline-flex items-center gap-1">
          Recent failures <ExternalLink size={11} />
        </Link>
      </div>
    </div>
  )
}
