'use client'

// XERO-API.2 PR 2 — searchable dropdown over cached Xero accounts.
//
// One-shot fetch on first mount, filtered client-side as the user
// types. The cache typically has 50-200 EXPENSE accounts which is
// small enough to ship in one payload and gives an instant
// keystroke response — no debounced server round-trips needed.
//
// Empty state: when the cache is empty OR stale (>30d), we show a
// nudge with a link to /settings/locations/<id> so the bookkeeper
// can press Refresh on the Xero card.
//
// Output shape: passes back the full account row so the caller can
// store xero_account_id + display the code+name as the rendered
// label.

import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronDown, Search, AlertTriangle } from 'lucide-react'

// Abort the cache fetch if it hangs — a never-settling request would
// otherwise strand the picker on "Loading…" with no way to recover.
const REQUEST_TIMEOUT_MS = 12000

export default function XeroAccountPicker({ locationId, value, onChange, label = 'Xero account' }) {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef(null)

  // Fetch once per location_id mount.
  useEffect(() => {
    if (!locationId) { setLoading(false); return }
    let cancelled = false
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    setLoading(true)
    setError(null)
    fetch(`/api/locations/${locationId}/xero/accounts?type=EXPENSE`, { signal: controller.signal })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load accounts')
          setAccounts([])
        } else {
          setAccounts(j.accounts || [])
          setStale(!!j.stale)
        }
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.name === 'AbortError'
          ? 'Loading accounts timed out — reopen this invoice to retry.'
          : (e?.message || 'Network error'))
      })
      .finally(() => { clearTimeout(abortTimer); if (!cancelled) setLoading(false) })
    return () => { cancelled = true; clearTimeout(abortTimer); controller.abort() }
  }, [locationId])

  // Close when clicking outside the popover.
  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selected = useMemo(
    () => accounts.find((a) => a.xero_account_id === value) || null,
    [accounts, value]
  )

  // Cheap client-side substring filter on code + name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return accounts.slice(0, 50)
    return accounts.filter((a) => {
      const code = (a.code || '').toLowerCase()
      const name = (a.name || '').toLowerCase()
      return code.includes(q) || name.includes(q)
    }).slice(0, 50)
  }, [accounts, query])

  const buttonLabel = selected
    ? `${selected.code ? selected.code + ' — ' : ''}${selected.name}`
    : (loading ? 'Loading…' : (accounts.length === 0 ? 'No accounts cached' : 'Pick an account…'))

  return (
    <div className="block" ref={wrapRef}>
      <span className="text-xs uppercase tracking-wide text-un1t-subtle">{label}</span>
      <div className="relative mt-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text text-left inline-flex items-center justify-between gap-2"
        >
          <span className={selected ? '' : 'text-un1t-subtle'}>{buttonLabel}</span>
          <ChevronDown size={14} className="shrink-0 text-un1t-subtle" />
        </button>

        {open && (
          <div className="absolute z-20 mt-1 w-full bg-un1t-bg border border-un1t-border rounded-md shadow-xl max-h-72 overflow-hidden flex flex-col">
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-un1t-border/50">
              <Search size={12} className="text-un1t-subtle" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search code or name…"
                className="flex-1 bg-transparent text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none"
              />
            </div>
            {error && (
              <div className="p-2 text-xs text-red-400">{error}</div>
            )}
            {!error && accounts.length === 0 && !loading && (
              <div className="p-2 text-xs text-un1t-subtle">
                No accounts cached. Press <strong>Refresh</strong> on the Xero card in
                {' '}<a className="underline" href={`/settings/locations/${locationId}`} target="_blank" rel="noreferrer">Settings</a>.
              </div>
            )}
            {!error && filtered.length === 0 && query && (
              <div className="p-2 text-xs text-un1t-subtle">No matches for &ldquo;{query}&rdquo;.</div>
            )}
            <ul className="overflow-y-auto">
              {filtered.map((a) => (
                <li key={a.xero_account_id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange?.(a.xero_account_id, a)
                      setOpen(false)
                      setQuery('')
                    }}
                    className={`w-full text-left px-2 py-1.5 text-sm hover:bg-un1t-border/30 ${selected?.xero_account_id === a.xero_account_id ? 'bg-un1t-border/40' : ''}`}
                  >
                    <div className="text-un1t-text">
                      {a.code && <span className="text-un1t-subtle mr-1">{a.code}</span>}
                      {a.name}
                    </div>
                    {a.tax_type && (
                      <div className="text-[10px] text-un1t-subtle">Tax: {a.tax_type}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {stale && accounts.length > 0 && (
              <div className="px-2 py-1.5 border-t border-un1t-border/50 text-[10px] text-amber-400 inline-flex items-center gap-1">
                <AlertTriangle size={10} /> Cache older than 30 days — consider refreshing in Settings.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
