'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Projector, Play, Pencil, Copy, Check } from 'lucide-react'

export default function PresentationsClient({ locationId, appUrl }) {
  const [decks, setDecks] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)

  async function load() {
    try {
      const r = await fetch(`/api/presentations?location_id=${locationId}`, { cache: 'no-store' })
      const j = await r.json()
      if (j.success) setDecks(j.presentations || [])
    } finally { setLoading(false) }
  }
  useEffect(() => {
    if (locationId) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  async function create(e) {
    e.preventDefault()
    if (!title.trim()) return
    setError(null)
    const r = await fetch('/api/presentations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, title: title.trim() }),
    })
    const j = await r.json()
    if (!j.success) { setError(j.error || 'Could not create'); return }
    setTitle(''); setCreating(false); load()
  }
  function viewerUrl(token) { return `${appUrl || ''}/present/${token}` }
  async function copy(token) {
    try { await navigator.clipboard.writeText(viewerUrl(token)); setCopied(token); setTimeout(() => setCopied(null), 1500) } catch { /* ignore */ }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">Presentations</h1>
          <p className="text-sm text-un1t-subtle mt-1">Run a slide deck across multiple screens from your laptop.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">
          <Plus size={15} /> New presentation
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="mb-5 rounded-xl border border-un1t-border bg-white p-4 flex gap-2">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Workshop title"
            className="flex-1 rounded-md border border-un1t-border px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white">Create</button>
          <button type="button" onClick={() => { setCreating(false); setTitle('') }} className="rounded-md px-3 py-2 text-sm text-un1t-subtle">Cancel</button>
        </form>
      )}
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-un1t-subtle">Loading…</p>
      ) : decks.length === 0 ? (
        <div className="rounded-xl border border-un1t-border bg-un1t-surface p-6 text-center text-sm text-un1t-subtle">
          <Projector className="mx-auto mb-2 text-un1t-muted" /> No decks yet. Create one, then upload your exported slide images.
        </div>
      ) : (
        <ul className="space-y-2">
          {decks.map((d) => (
            <li key={d.id} className="rounded-xl border border-un1t-border bg-white p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium truncate">{d.title}</p>
                <p className="text-xs text-un1t-subtle">{d.slide_count} slide{d.slide_count === 1 ? '' : 's'}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" onClick={() => copy(d.view_token)} title="Copy viewer link"
                  className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
                  {copied === d.view_token ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Viewer link</>}
                </button>
                <Link href={`/presentations/${d.id}`} className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
                  <Pencil size={13} /> Edit
                </Link>
                <Link href={`/presentations/${d.id}/present`} className="inline-flex items-center gap-1 rounded-md bg-un1t-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                  <Play size={13} /> Present
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
