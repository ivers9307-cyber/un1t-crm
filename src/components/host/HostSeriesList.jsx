'use client'
// HostSeriesList — HOSTSERIES.1. The host dashboard's series: name, how many
// published dates are still to come, the public link, and an inline editor
// for the page copy (headline, blurb) saved with PATCH /api/host/series/<id>.

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { HOST_BTN_GHOST, HOST_EYEBROW, HOST_INPUT, HOST_LABEL, HOST_LIST, HOST_META, HOST_ROW } from './host-ui'

function SeriesRow({ s }) {
  const [editing, setEditing] = useState(false)
  const [headline, setHeadline] = useState(s.headline || '')
  const [blurb, setBlurb] = useState(s.blurb || '')
  const [saved, setSaved] = useState({ headline: s.headline || '', blurb: s.blurb || '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/host/series/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headline, blurb }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.message || json.error || 'Could not save.'); return }
      setSaved({ headline, blurb })
      setEditing(false)
    } catch (err) {
      setError(err?.message || 'Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={HOST_ROW}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium truncate">{s.name}</p>
          <p className={HOST_META}>
            {s.upcoming_count} upcoming {s.upcoming_count === 1 ? 'date' : 'dates'}
            {saved.headline ? ` · “${saved.headline}”` : ''}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-4 text-xs">
          <button type="button" onClick={() => setEditing((v) => !v)} className={HOST_BTN_GHOST}>{editing ? 'Close' : 'Page copy'}</button>
          <a href={`/event/series/${s.slug}`} target="_blank" rel="noopener noreferrer" className={HOST_BTN_GHOST}>View page</a>
        </div>
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={`sh-${s.id}`} className={`${HOST_LABEL} mb-1`}>Headline</label>
            <input id={`sh-${s.id}`} type="text" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} placeholder={s.name} className={HOST_INPUT} />
          </div>
          <div>
            <label htmlFor={`sb-${s.id}`} className={`${HOST_LABEL} mb-1`}>Blurb</label>
            <input id={`sb-${s.id}`} type="text" value={blurb} onChange={(e) => setBlurb(e.target.value)} maxLength={500} placeholder="Pick a date" className={HOST_INPUT} />
          </div>
          {error && <p role="alert" className="sm:col-span-2 text-sm text-host-warn">{error}</p>}
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-host-accent text-host-on-accent text-xs font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-1.5">
              {busy && <Loader2 size={12} className="animate-spin" />} Save copy
            </button>
          </div>
        </form>
      )}
    </li>
  )
}

export default function HostSeriesList({ series }) {
  const list = Array.isArray(series) ? series : []
  if (list.length === 0) return null
  return (
    <section className="mt-8">
      <h2 className={`${HOST_EYEBROW} mb-3`}>Series</h2>
      <ul className={`${HOST_LIST} overflow-hidden`}>
        {list.map((s) => <SeriesRow key={s.id} s={s} />)}
      </ul>
      <p className={`mt-2 ${HOST_META}`}>A series is one link that lists every published date. Make one from any event&apos;s page.</p>
    </section>
  )
}
