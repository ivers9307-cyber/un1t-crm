'use client'

// XERO-API.2 PR 2 — supplier autocomplete with inline "create new"
// fallback. Pattern mirrors Dext's supplier picker.
//
// Behaviour:
//   1. Type 2+ chars → debounced fetch to
//      /api/locations/<id>/xero/contacts?suppliers=1&q=…
//   2. Pick an existing contact → store xero_contact_id + name.
//   3. None of the results match → click "Create new contact"
//      → stores a pending-new sentinel:
//          {
//            kind: 'new',
//            name: <whatever was typed>,
//          }
//      PR 3 reads this sentinel inside the API push step and runs
//      upsertSupplierContact against Xero at send time.
//
// We expose the resolved value via onChange(value) where:
//   value = { kind:'existing', xero_contact_id, name, email? }
//        | { kind:'new', name }
//        | null
//
// Caller persists this into extracted_fields.xero_contact_ref so
// the downstream send step has everything it needs.

import { useState, useEffect, useRef } from 'react'
import { Search, X, UserPlus, AlertTriangle } from 'lucide-react'

const MIN_QUERY = 2
const DEBOUNCE_MS = 200
// Abort a search that hasn't come back in time. Without this, a fetch
// that never settles (cold serverless start, dropped connection, a
// hung function) strands the picker on "Searching…" forever — the
// only `finally` that clears `loading` lives inside that fetch.
const REQUEST_TIMEOUT_MS = 12000

export default function XeroContactPicker({ locationId, value, onChange, label = 'Xero supplier', initialName }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(initialName || '')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  // Reset internal query when caller wipes value externally (e.g.
  // re-extraction returned a new supplier_name) BUT preserve the
  // user's in-progress typing.
  useEffect(() => {
    if (value === null && !open) setQuery(initialName || '')
  }, [value, initialName, open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Debounced search.
  useEffect(() => {
    if (!locationId) {
      // No location to search against — clear loading so the box
      // shows its idle state instead of a stranded "Searching…".
      setResults([])
      setLoading(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < MIN_QUERY) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController()
      const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetch(
          `/api/locations/${locationId}/xero/contacts?suppliers=1&q=${encodeURIComponent(q)}&limit=25`,
          { signal: controller.signal }
        )
        const j = await res.json()
        if (!j.success) {
          setError(j.error || 'Search failed')
          setResults([])
        } else {
          setError(null)
          setResults(j.contacts || [])
          setStale(!!j.stale)
        }
      } catch (e) {
        setError(
          e?.name === 'AbortError'
            ? 'Search timed out — check your connection and try again.'
            : (e?.message || 'Network error')
        )
        setResults([])
      } finally {
        clearTimeout(abortTimer)
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => debounceRef.current && clearTimeout(debounceRef.current)
  }, [query, locationId])

  function pickExisting(c) {
    onChange?.({
      kind: 'existing',
      xero_contact_id: c.xero_contact_id,
      name: c.name,
      email: c.email || null,
    })
    setQuery(c.name)
    setOpen(false)
  }

  function pickNew() {
    const name = query.trim()
    if (!name) return
    onChange?.({ kind: 'new', name })
    setOpen(false)
  }

  function clear() {
    onChange?.(null)
    setQuery('')
    setResults([])
    setOpen(false)
    inputRef.current?.focus()
  }

  // Determine which UX state we're in for the input affordance.
  const summary = (() => {
    if (!value) return null
    if (value.kind === 'existing') return { tone: 'success', text: value.name, sub: value.email || 'Existing Xero contact' }
    if (value.kind === 'new') return { tone: 'warning', text: value.name, sub: 'Will be created in Xero at send time' }
    return null
  })()

  return (
    <div className="block" ref={wrapRef}>
      <span className="text-xs uppercase tracking-wide text-un1t-subtle">{label}</span>
      <div className="relative mt-1">
        {summary ? (
          // Chip-shaped read-only view of the current pick. Click X
          // to clear back to the search input.
          <div className={`flex items-center justify-between gap-2 border rounded-md px-2 py-1.5 ${
            summary.tone === 'success' ? 'bg-un1t-bg border-emerald-500/40' : 'bg-un1t-bg border-amber-500/40'
          }`}>
            <div className="min-w-0">
              <div className="text-sm text-un1t-text truncate">{summary.text}</div>
              <div className={`text-[10px] truncate ${summary.tone === 'success' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {summary.tone === 'warning' && <UserPlus size={9} className="inline-block mr-1" />}
                {summary.sub}
              </div>
            </div>
            <button
              type="button"
              onClick={clear}
              className="text-un1t-subtle hover:text-un1t-text shrink-0"
              aria-label="Clear supplier"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1 bg-un1t-bg border border-un1t-grey rounded-md px-2 py-1.5">
            <Search size={12} className="text-un1t-subtle shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
              onFocus={() => setOpen(true)}
              placeholder="Search Xero suppliers…"
              className="flex-1 bg-transparent text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none"
            />
          </div>
        )}

        {open && !summary && (
          <div className="absolute z-20 mt-1 w-full bg-un1t-bg border border-un1t-grey rounded-md shadow-xl max-h-72 overflow-hidden flex flex-col">
            {error && <div className="p-2 text-xs text-red-400">{error}</div>}
            {!error && query.trim().length < MIN_QUERY && (
              <div className="p-2 text-xs text-un1t-subtle">Type at least {MIN_QUERY} characters to search.</div>
            )}
            {!error && query.trim().length >= MIN_QUERY && loading && (
              <div className="p-2 text-xs text-un1t-subtle">Searching…</div>
            )}
            {!error && !loading && query.trim().length >= MIN_QUERY && results.length === 0 && (
              <div className="p-2 text-xs text-un1t-subtle">No suppliers match &ldquo;{query.trim()}&rdquo;.</div>
            )}
            <ul className="overflow-y-auto">
              {results.map((c) => (
                <li key={c.xero_contact_id}>
                  <button
                    type="button"
                    onClick={() => pickExisting(c)}
                    className="w-full text-left px-2 py-1.5 text-sm hover:bg-un1t-grey/30"
                  >
                    <div className="text-un1t-text">{c.name}</div>
                    {c.email && <div className="text-[10px] text-un1t-subtle">{c.email}</div>}
                  </button>
                </li>
              ))}
            </ul>
            {query.trim().length >= MIN_QUERY && !loading && (
              <button
                type="button"
                onClick={pickNew}
                className="border-t border-un1t-grey/50 px-2 py-1.5 text-left text-xs text-amber-400 hover:bg-un1t-grey/20 inline-flex items-center gap-1.5"
              >
                <UserPlus size={11} />
                Create new Xero contact: <strong className="text-amber-300">{query.trim()}</strong>
              </button>
            )}
            {stale && (
              <div className="px-2 py-1.5 border-t border-un1t-grey/50 text-[10px] text-amber-400 inline-flex items-center gap-1">
                <AlertTriangle size={10} /> Contact cache older than 30 days — refresh in Settings.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
