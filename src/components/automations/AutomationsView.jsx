'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Zap, AlertCircle, ExternalLink } from 'lucide-react'

export default function AutomationsView({ locationId, _locationName, cards }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-un1t-text">Quick automations</h2>
        <p className="text-xs text-un1t-subtle mt-0.5">Each one is off until you turn it on.</p>
      </div>

      {cards.map((card) => (
        <AutomationCard key={card.key} card={card} locationId={locationId} />
      ))}

      <div className="text-xs text-un1t-subtle border-t border-un1t-border pt-3">
        See also:{' '}
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

  const [bf, setBf] = useState({ phase: 'idle', eligible: null, done: 0, created: 0, linked: 0, needs_review: 0, failed: 0, error: null })

  async function openBackfill() {
    setBf((s) => ({ ...s, phase: 'counting', error: null }))
    try {
      const res = await fetch(`/api/automations/${card.key}/backfill?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Count failed')
      setBf((s) => ({ ...s, phase: 'confirm', eligible: j.data.eligible }))
    } catch (e) { setBf((s) => ({ ...s, phase: 'idle', error: e.message })) }
  }

  async function runBackfill() {
    setBf((s) => ({ ...s, phase: 'running', error: null, done: 0, created: 0, linked: 0, needs_review: 0, failed: 0 }))
    try {
      // Hard cap (500 batches × 20 = 10k) as belt-and-braces; real
      // termination is the server's remaining===0 / processed===0 below.
      for (let i = 0; i < 500; i++) {
        const res = await fetch(`/api/automations/${card.key}/backfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId }),
        })
        const j = await res.json()
        if (!res.ok || j.success === false) throw new Error(j.error || 'Backfill failed')
        const d = j.data
        setBf((s) => ({
          ...s,
          done: s.done + d.processed,
          created: s.created + d.created,
          linked: s.linked + d.linked,
          needs_review: s.needs_review + d.needs_review,
          failed: s.failed + d.failed,
          eligible: d.remaining + (s.done + d.processed),
        }))
        if (d.processed === 0 || d.remaining === 0) break
      }
      setBf((s) => ({ ...s, phase: 'done' }))
      router.refresh()
    } catch (e) { setBf((s) => ({ ...s, phase: 'done', error: e.message })) }
  }

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
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-un1t-subtle" />
            <h2 className="font-semibold text-un1t-text">{card.label}</h2>
          </div>
          <p className="text-sm text-un1t-subtle mt-1">{card.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-semibold ${enabled ? 'text-emerald-700' : 'text-un1t-subtle'}`}>
            {enabled ? 'On' : 'Off'}
          </span>
          <button
            type="button"
            onClick={toggle}
            disabled={disabled}
            aria-pressed={enabled}
            aria-label={enabled ? 'Turn automation off' : 'Turn automation on'}
            title={disabled ? 'Connect Glofox at this location to enable' : (enabled ? 'Turn off' : 'Turn on')}
            className={`inline-flex h-6 w-11 items-center rounded-full border transition disabled:opacity-50 disabled:cursor-not-allowed ${enabled ? 'bg-emerald-500 border-emerald-600' : 'bg-un1t-muted border-un1t-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
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

      {busy && <p className="mt-2 text-[11px] text-un1t-subtle inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Saving…</p>}
      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      <div className="mt-3 border-t border-un1t-border/60 pt-2">
        <Link href={card.reviewBase} className="text-[11px] text-un1t-subtle underline inline-flex items-center gap-1">
          Recent failures <ExternalLink size={11} />
        </Link>
        {card.supportsBackfill && card.status.available && (
          <div className="mt-2">
            {bf.phase === 'idle' && (
              <button type="button" onClick={openBackfill} disabled={!locationId}
                className="text-xs underline text-un1t-subtle hover:text-un1t-text">
                Push existing un-linked leads…
              </button>
            )}
            {bf.phase === 'counting' && <p className="text-[11px] text-un1t-subtle">Counting eligible leads…</p>}
            {bf.phase === 'confirm' && (
              <div className="text-xs text-un1t-text bg-amber-500/10 border border-amber-500/30 rounded p-2">
                This will create <b>{bf.eligible}</b> Glofox account{bf.eligible === 1 ? '' : 's'} + trial{bf.eligible === 1 ? '' : 's'} for existing un-linked leads.
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={runBackfill} disabled={!bf.eligible}
                    className="px-2 py-1 rounded bg-un1t-text text-un1t-bg font-semibold disabled:opacity-40">
                    {bf.eligible ? 'Run now' : 'Nothing to do'}
                  </button>
                  <button type="button" onClick={() => setBf((s) => ({ ...s, phase: 'idle' }))} className="px-2 py-1 underline text-un1t-subtle">Cancel</button>
                </div>
              </div>
            )}
            {bf.phase === 'running' && (
              <p className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> Pushing… {bf.done} done{bf.eligible != null ? ` / ${bf.eligible}` : ''} (created {bf.created}, linked {bf.linked}, review {bf.needs_review})
              </p>
            )}
            {bf.phase === 'done' && (
              <p className="text-[11px] text-emerald-700">
                Done — {bf.created} created, {bf.linked} linked{bf.needs_review ? `, ${bf.needs_review} need review` : ''}{bf.failed ? `, ${bf.failed} failed` : ''}.
                {(bf.needs_review || bf.failed) ? <> See <Link href={card.reviewBase} className="underline">Review</Link>.</> : null}
              </p>
            )}
            {bf.error && <p className="text-[11px] text-red-700 mt-1">{bf.error}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
