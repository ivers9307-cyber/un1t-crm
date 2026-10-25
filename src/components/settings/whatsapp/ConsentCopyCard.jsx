'use client'

// WAORGNUMBER.3 (R6) — "Replies to STOP and START". Since R6 a STOP or START in
// a WhatsApp thread at this studio acts at this studio only, and the reply names
// the studio. Each reply is editable here (customer-comms-editable rule); blank
// = the default shown as the placeholder. {studio} becomes the studio's name.
//
//   GET /api/locations/[id]/whatsapp/consent-copy   { copy, defaults, studio_name, can_edit }
//   PUT /api/locations/[id]/whatsapp/consent-copy   { stop_ack, start_ack }
//
// Nothing is shown over a read that failed (CHANNELREAD.1): empty boxes over an
// unknown saved text would invite a save that wipes it.

import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { CONSENT_COPY_MAX, STUDIO_PLACEHOLDER } from '@/lib/whatsapp-consent-copy'

const FIELDS = [
  { key: 'stop_ack', label: 'Reply to STOP', hint: 'Sent when someone replies STOP in a thread at this studio. It stops this studio\'s WhatsApp marketing only.' },
  { key: 'start_ack', label: 'Reply to START', hint: 'Sent when someone replies START here to opt back in to this studio\'s WhatsApp messages.' },
]

export default function ConsentCopyCard({ locationId, canEdit: canEditProp = true }) {
  const [state, setState] = useState('loading') // loading | ready | failed
  const [values, setValues] = useState({ stop_ack: '', start_ack: '' })
  const [defaults, setDefaults] = useState({})
  const [studioName, setStudioName] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const apply = (data) => {
    setValues({ stop_ack: data.copy.stop_ack || '', start_ack: data.copy.start_ack || '' })
    setDefaults(data.defaults || {})
    if (data.studio_name) setStudioName(data.studio_name)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setState('loading')
      try {
        const res = await fetch(`/api/locations/${locationId}/whatsapp/consent-copy`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success || !j.data?.copy) {
          setState('failed')
          return
        }
        apply(j.data)
        setCanEdit(j.data.can_edit === true)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  async function save() {
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/consent-copy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stop_ack: values.stop_ack.trim() || null, start_ack: values.start_ack.trim() || null }),
      })
      const j = await res.json()
      if (!res.ok || !j.success || !j.data?.copy) throw new Error(j.error || 'Could not save these replies')
      apply(j.data)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const editable = canEdit && canEditProp
  const preview = (key) => (values[key].trim() || defaults[key] || '').split(STUDIO_PLACEHOLDER).join(studioName || 'this studio')

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Replies to STOP and START</h4>
        <p className="text-xs text-un1t-subtle">
          A STOP or START in a WhatsApp chat with this studio changes this studio&apos;s WhatsApp
          marketing only, and the customer gets the reply below. Leave a box blank to use the
          default. {STUDIO_PLACEHOLDER} is replaced with the studio&apos;s name.
        </p>
      </div>

      {state === 'loading' && (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {state === 'failed' && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Could not load these replies just now. Reload the page to try again.
        </div>
      )}

      {state === 'ready' && FIELDS.map(({ key, label, hint }) => {
        const id = `wa-consent-${key}`
        const over = values[key].trim().length > CONSENT_COPY_MAX
        return (
          <div key={key} className="space-y-0.5">
            <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-un1t-subtle">{label}</label>
            <textarea
              id={id}
              rows={2}
              disabled={!editable || busy}
              placeholder={defaults[key] || ''}
              value={values[key]}
              onChange={(e) => { setSaved(false); setValues((v) => ({ ...v, [key]: e.target.value })) }}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text disabled:opacity-60"
            />
            <div className="flex items-start justify-between gap-2 text-[10px]">
              <span className="text-un1t-muted">{hint}</span>
              <span className={over ? 'text-red-700 whitespace-nowrap' : 'text-un1t-muted whitespace-nowrap'}>
                {values[key].trim().length}/{CONSENT_COPY_MAX}
              </span>
            </div>
            <div className="text-[10px] text-un1t-subtle">Customer sees: {preview(key)}</div>
          </div>
        )
      })}

      {state === 'ready' && editable && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || FIELDS.some(({ key }) => values[key].trim().length > CONSENT_COPY_MAX)}
            className="px-2.5 py-1 rounded bg-un1t-accent text-white text-[11px] font-medium disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save replies'}
          </button>
          {saved && (
            <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
              <CheckCircle2 size={11} /> Saved
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {state === 'ready' && !editable && (
        <p className="text-[11px] text-un1t-subtle">An owner or manager can change these.</p>
      )}
    </div>
  )
}
