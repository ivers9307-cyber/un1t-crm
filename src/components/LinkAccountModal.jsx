'use client'
// LinkAccountModal.jsx — PERSON-LINK.1
//
// Modal for linking a contact to a person_group.
// Searches POST /api/contacts/search (reuses the existing endpoint,
// same shape as ContactMultiSelect.jsx). Excludes the current contactId
// from results. Selecting a candidate and confirming calls:
//   POST /api/contacts/{contactId}/link  { otherContactId: selectedId }
//
// Props:
//   contactId  — the contact we're linking FROM (string UUID)
//   locationId — active location to scope the search (string UUID)
//   open       — boolean
//   onClose    — () => void

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Modal, Button } from '@/components/ui'
import { initials, accountStatusLabel } from '@/lib/person-view'

export default function LinkAccountModal({ contactId, locationId, open, onClose }) {
  const router = useRouter()
  const inputRef = useRef(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(null)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState(null)

  // Reset state each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelected(null)
      setError(null)
      setLinking(false)
      // Focus the search input after the modal mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  // Debounced search — reuses POST /api/contacts/search (min 2 chars).
  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/contacts/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            search: term,
            location_id: locationId,
            limit: 20,
            filter: { logic: 'and', filters: [] },
          }),
        })
        const data = await res.json()
        if (!alive) return
        const contacts = data?.success ? (data.contacts || []) : []
        // Exclude the contact we're linking FROM — can't link to yourself.
        setResults(contacts.filter((c) => c.id !== contactId))
      } catch {
        if (alive) setResults([])
      } finally {
        if (alive) setSearching(false)
      }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [query, locationId, contactId])

  async function handleLink() {
    if (!selected) return
    setLinking(true)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otherContactId: selected.id }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Link failed (${r.status})`)
        setLinking(false)
        return
      }
      router.refresh()
      onClose()
    } catch (e) {
      setError(e?.message || 'Network error')
      setLinking(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link a duplicate account"
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={linking}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={linking}
            disabled={!selected || linking}
            onClick={handleLink}
          >
            Link account
          </Button>
        </>
      }
    >
      <p className="text-sm text-un1t-subtle mb-3">
        Search for another contact at this location that belongs to the same real person.
        Linking groups their accounts — outreach and arrears are de-duplicated across the group.
      </p>

      {/* Search input */}
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-un1t-subtle" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(null) }}
          placeholder="Search by name, email or phone…"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md pl-9 pr-9 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30"
        />
        {searching && (
          <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-un1t-subtle" aria-hidden="true" />
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Results list */}
      {results.length > 0 && (
        <div className="border border-un1t-border rounded-lg overflow-hidden mb-2">
          {results.map((c) => {
            const isSelected = selected?.id === c.id
            const abbr = initials(c.name)
            const statusLabel = c.glofox_membership_status
              ? accountStatusLabel(c.glofox_membership_status)
              : null
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(isSelected ? null : c)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-b border-un1t-border/50 last:border-b-0 ${
                  isSelected
                    ? 'bg-un1t-text/[0.06]'
                    : 'hover:bg-un1t-surface'
                }`}
              >
                {/* Avatar */}
                <div
                  aria-hidden="true"
                  className="flex-none h-8 w-8 rounded-full bg-un1t-text/[0.06] flex items-center justify-center text-xs font-semibold text-un1t-text"
                >
                  {abbr}
                </div>
                {/* Details */}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-un1t-text truncate">{c.name || '—'}</div>
                  <div className="text-[11px] text-un1t-muted truncate">
                    {[c.email, c.phone, statusLabel].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {/* Selected indicator */}
                {isSelected && (
                  <CheckCircle2 size={16} className="flex-none text-emerald-600" aria-hidden="true" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* No-results note (only after a search attempt) */}
      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-sm text-un1t-subtle text-center py-4">
          No contacts found for &ldquo;{query.trim()}&rdquo;.
        </p>
      )}

      {/* Selected summary */}
      {selected && (
        <p className="text-xs text-un1t-subtle mt-2">
          Will link <strong className="text-un1t-text">{selected.name || selected.email || selected.id}</strong> to this person group.
        </p>
      )}
    </Modal>
  )
}
