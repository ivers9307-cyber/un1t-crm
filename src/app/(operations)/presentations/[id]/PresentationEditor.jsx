'use client'
// PRESENT — author a deck: upload slide images, reorder, delete, copy viewer link.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, Trash2, ArrowUp, ArrowDown, Copy, Check, Play } from 'lucide-react'

export default function PresentationEditor({ id, title, viewToken, appUrl }) {
  const [slides, setSlides] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef(null)

  async function load() {
    const r = await fetch(`/api/presentations/${id}`, { cache: 'no-store' })
    const j = await r.json()
    if (j.success) setSlides(j.presentation.slides || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function onFiles(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true); setError(null)
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await fetch(`/api/presentations/${id}/slides`, { method: 'POST', body: fd })
    const j = await r.json()
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    if (!j.success) { setError(j.error || 'Upload failed'); return }
    load()
  }

  async function remove(slideId) {
    if (!confirm('Delete this slide?')) return
    setBusy(true)
    await fetch(`/api/presentations/${id}/slides/${slideId}`, { method: 'DELETE' })
    setBusy(false); load()
  }

  async function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= slides.length) return
    const order = slides.map((s) => s.id)
    ;[order[i], order[j]] = [order[j], order[i]]
    setSlides((prev) => { const c = [...prev]; [c[i], c[j]] = [c[j], c[i]]; return c }) // optimistic
    setBusy(true)
    await fetch(`/api/presentations/${id}/slides/reorder`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }),
    })
    setBusy(false)
  }

  const viewerUrl = `${appUrl || ''}/present/${viewToken}`
  async function copy() { try { await navigator.clipboard.writeText(viewerUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/presentations" className="text-xs text-un1t-subtle hover:text-un1t-text">← Presentations</Link>
          <h1 className="text-2xl font-bold">{title}</h1>
        </div>
        <Link href={`/presentations/${id}/present`} className="inline-flex items-center gap-1.5 rounded-md bg-un1t-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          <Play size={15} /> Present
        </Link>
      </div>

      <div className="rounded-xl border border-un1t-border bg-un1t-surface p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-un1t-subtle">Viewer link (open this on each screen)</p>
          <p className="truncate text-sm font-mono">{viewerUrl}</p>
        </div>
        <button type="button" onClick={copy} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-un1t-border bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>

      <div>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFiles} className="hidden" />
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <Upload size={15} /> {busy ? 'Uploading…' : 'Upload slides'}
        </button>
        <p className="mt-1 text-xs text-un1t-subtle">In PowerPoint: Export → JPEG/PNG → “All Slides”, then select them all here. They sort by filename (Slide1, Slide2, …).</p>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      {loading ? <p className="text-sm text-un1t-subtle">Loading…</p> : (
        <ul className="space-y-2">
          {slides.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-un1t-border bg-white p-2">
              <span className="w-6 text-center text-xs text-un1t-subtle tabular-nums">{i + 1}</span>
              <img src={s.url} alt="" className="h-14 w-24 rounded object-cover bg-black" />
              <div className="ml-auto flex items-center gap-1">
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface disabled:opacity-30"><ArrowUp size={15} /></button>
                <button type="button" disabled={busy || i === slides.length - 1} onClick={() => move(i, 1)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface disabled:opacity-30"><ArrowDown size={15} /></button>
                <button type="button" disabled={busy} onClick={() => remove(s.id)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface" aria-label="Delete"><Trash2 size={15} /></button>
              </div>
            </li>
          ))}
          {slides.length === 0 && <li className="rounded-lg border border-un1t-border bg-un1t-surface p-4 text-center text-sm text-un1t-subtle">No slides yet — upload your exported images above.</li>}
        </ul>
      )}
    </div>
  )
}
