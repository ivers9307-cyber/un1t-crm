'use client'

// PILLAR2 — type-ahead multi-select of specific contacts for the unified send
// composer's "pick people" mode. Searches POST /api/contacts/search (session-
// authed, location-scoped) and renders picked contacts as removable chips. The
// composer turns the picks into an `{ field:'id', op:'in', value:[ids] }` filter
// so they ride the same send path (consent/status gates still apply at send).
import { useEffect, useRef, useState } from 'react'
import { Search, X, Loader2 } from 'lucide-react'

const fieldCls =
  'w-full bg-un1t-bg border border-un1t-border rounded-md pl-8 pr-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

export default function ContactMultiSelect({ locationId, value = [], onChange }) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  const pickedIds = new Set(value.map(v => v.id))

  // Debounced search (min 2 chars).
  useEffect(() => {
    const term = input.trim()
    if (term.length < 2) { setResults([]); setLoading(false); return }
    let alive = true
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/contacts/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ search: term, location_id: locationId, limit: 20, filter: { logic: 'and', filters: [] } }),
        })
        const data = await res.json()
        if (alive) { setResults(data?.success ? (data.contacts || []) : []); setOpen(true) }
      } catch {
        if (alive) setResults([])
      } finally {
        if (alive) setLoading(false)
      }
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [input, locationId])

  // Dismiss the dropdown on outside click.
  useEffect(() => {
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const add = (c) => {
    if (!pickedIds.has(c.id)) onChange([...value, { id: c.id, name: c.name, email: c.email, phone: c.phone }])
    setInput(''); setResults([]); setOpen(false)
  }
  const remove = (id) => onChange(value.filter(v => v.id !== id))

  return (
    <div ref={boxRef} className="relative">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map(c => (
            <span key={c.id} className="inline-flex items-center gap-1 text-xs bg-un1t-text/[0.06] border border-un1t-border rounded-full pl-2 pr-1 py-0.5 text-un1t-text">
              {c.name || c.email || c.phone || c.id}
              <button type="button" onClick={() => remove(c.id)} className="text-un1t-subtle hover:text-rose-700" aria-label="Remove"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-un1t-subtle" />
        <input className={fieldCls} value={input} onChange={e => setInput(e.target.value)}
          onFocus={() => results.length && setOpen(true)} placeholder="Search contacts by name, email or phone…" />
        {loading && <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-un1t-subtle" />}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-un1t-border bg-un1t-surface shadow-lg">
          {results.map(c => (
            <button key={c.id} type="button" onClick={() => add(c)} disabled={pickedIds.has(c.id)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-un1t-bg/40 disabled:opacity-40 flex items-center justify-between gap-2">
              <span className="text-un1t-text truncate">{c.name || '—'}</span>
              <span className="text-[11px] text-un1t-subtle truncate">{c.email || c.phone || ''}</span>
            </button>
          ))}
        </div>
      )}
      {value.length > 0 && (
        <p className="mt-1 text-[11px] text-un1t-subtle">{value.length} selected · opted-out / unreachable contacts are still skipped at send.</p>
      )}
    </div>
  )
}
