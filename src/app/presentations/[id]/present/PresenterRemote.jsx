'use client'
// PRESENT — presenter remote. Prev/Next + arrow/space keys + jump grid.
// Each navigation POSTs /advance {index}; the public viewers follow on their poll.
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { clampIndex } from '@/lib/presentations'

export default function PresenterRemote({ id, title, initialIndex, slides }) {
  const [index, setIndex] = useState(clampIndex(initialIndex, slides.length))
  const [busy, setBusy] = useState(false)
  const total = slides.length

  const go = useCallback(async (target) => {
    const next = clampIndex(target, total)
    setIndex(next) // optimistic
    setBusy(true)
    try {
      const r = await fetch(`/api/presentations/${id}/advance`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: next }),
      })
      const j = await r.json()
      if (j.success && typeof j.current_index === 'number') setIndex(j.current_index)
    } catch { /* keep optimistic */ } finally { setBusy(false) }
  }, [id, total])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(index + 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'Backspace' || e.key === 'PageUp') { e.preventDefault(); go(index - 1) }
      else if (e.key === 'Home') { e.preventDefault(); go(0) }
      else if (e.key === 'End') { e.preventDefault(); go(total - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, go])

  if (total === 0) {
    return <div className="p-6 text-sm text-un1t-subtle">This deck has no slides yet. Add slides on the edit page first.</div>
  }
  const next = slides[index + 1]
  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <span className="text-sm text-un1t-subtle tabular-nums">Slide {index + 1} / {total}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
        <div className="rounded-xl border border-un1t-border bg-black aspect-video overflow-hidden flex items-center justify-center">
          <img src={slides[index].url} alt="" className="max-h-full max-w-full object-contain" />
        </div>
        <div className="rounded-xl border border-un1t-border bg-black/90 aspect-video overflow-hidden flex items-center justify-center">
          {next ? <img src={next.url} alt="" className="max-h-full max-w-full object-contain opacity-90" />
                : <span className="text-xs text-un1t-subtle">End of deck</span>}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button type="button" disabled={busy || index === 0} onClick={() => go(index - 1)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-un1t-border px-5 py-3 text-base font-medium hover:bg-un1t-surface disabled:opacity-40">
          <ChevronLeft size={18} /> Prev
        </button>
        <button type="button" disabled={busy || index >= total - 1} onClick={() => go(index + 1)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-6 py-3 text-base font-semibold text-white hover:bg-emerald-500 disabled:opacity-40">
          Next <ChevronRight size={18} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 pt-2">
        {slides.map((s, i) => (
          <button key={s.id} type="button" onClick={() => go(i)}
            className={`h-12 w-20 overflow-hidden rounded border ${i === index ? 'border-emerald-500 ring-2 ring-emerald-500/40' : 'border-un1t-border'}`}>
            <img src={s.url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      <p className="text-center text-xs text-un1t-subtle">Use ← → or space to advance. Viewers update within ~1 second.</p>
    </div>
  )
}
