'use client'

// ORGCONTACTS.0 (spec §3.3, decision 6; WAORGNUMBER R7) — "Sign-off until".
// While this date is in the future, broadcasts at the studio go out only once
// an organisation admin has signed them off (src/lib/whatsapp-blast-signoff.js).
// Until now the date was set by hand at go-live; this card is its UI.
//
//   GET /api/locations/[id]/whatsapp/blast-signoff   { until, can_edit }
//   PUT /api/locations/[id]/whatsapp/blast-signoff   { until | null }
//
// The route decides who may edit (master or an org admin of the studio's
// organisation); everyone else sees the date read-only. Nothing is shown over
// a read that failed (CHANNELREAD.1).

import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { formatInZone } from 'shared/zoned-time'

export const SIGNOFF_HINT = "Blasts at this studio need an organisation admin's sign-off until this date. Clear it to end the window."

// The window's plain date as a calendar day (noon UTC keeps it on its own day).
const dayLabel = (until) => formatInZone(new Date(`${until}T12:00:00Z`), 'UTC', { day: 'numeric', month: 'short', year: 'numeric' }, 'en-GB')

export default function BlastSignoffCard({ locationId }) {
  const [state, setState] = useState('loading') // loading | ready | failed
  const [until, setUntil] = useState(null)
  const [draft, setDraft] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setState('loading')
      try {
        const res = await fetch(`/api/locations/${locationId}/whatsapp/blast-signoff`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success || !j.data) { setState('failed'); return }
        setUntil(j.data.until || null)
        setDraft(j.data.until || '')
        setCanEdit(j.data.can_edit === true)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  async function put(next) {
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/blast-signoff`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: next }),
      })
      const j = await res.json()
      if (!res.ok || !j.success || !j.data) throw new Error(j.error || 'Could not save the sign-off date')
      setUntil(j.data.until || null)
      setDraft(j.data.until || '')
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const id = 'wa-blast-signoff-until'

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Blast sign-off</h4>
        <p className="text-xs text-un1t-subtle">{SIGNOFF_HINT}</p>
      </div>

      {state === 'loading' && (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {state === 'failed' && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Could not load the sign-off window just now. Reload the page to try again.
        </div>
      )}

      {state === 'ready' && !canEdit && (
        <div className="text-xs text-un1t-text">
          {until ? <>Sign-off needed until <span className="font-medium">{dayLabel(until)}</span>.</> : 'No sign-off window is set.'}
        </div>
      )}

      {state === 'ready' && canEdit && (
        <div className="space-y-1">
          <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-un1t-subtle">Sign-off until</label>
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="date"
              disabled={busy}
              value={draft}
              onChange={(e) => { setSaved(false); setDraft(e.target.value) }}
              className="bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => put(draft.trim() || null)}
              disabled={busy || draft.trim() === (until || '')}
              className="px-2.5 py-1 rounded bg-un1t-accent text-white text-[11px] font-medium disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => put(null)}
              disabled={busy || !until}
              className="px-2.5 py-1 rounded border border-un1t-border text-un1t-text text-[11px] font-medium disabled:opacity-60"
            >
              Clear
            </button>
            {saved && <span className="text-[11px] text-green-700 inline-flex items-center gap-1"><CheckCircle2 size={12} /> Saved</span>}
          </div>
          {error && <div className="text-xs text-red-700 inline-flex items-center gap-1.5"><AlertCircle size={12} /> {error}</div>}
        </div>
      )}
    </div>
  )
}
