'use client'

// /contacts page top-level — owns:
//   - simple status chip filter (existing UX, URL-driven)
//   - free-text search box
//   - advanced filter via AudienceBuilder (the same one campaigns use)
//   - the table itself, with bulk-select handled by ContactsTable
//
// Two data paths:
//   - When no advanced filter is set, server-rendered initial contacts
//     are shown (the parent server component handed them to us).
//   - When advanced filter has ≥1 row, we POST /api/contacts/search and
//     render the API's response. Status chips + search are passed
//     through as well so they compose with the audience filter.
//
// This keeps the no-filter case fast (zero client round-trips, server
// HTML is already in the bundle) while unlocking power-user filtering
// when the operator opts in.

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { Filter, X } from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'
import ContactsTable from './ContactsTable'

const STATUSES = ['', 'active_trial', 'member', 'cold', 'lost_member', 'returning']

export default function ContactsView({
  initialContacts,
  locationId,
  initialStatus = '',
  initialSearch = '',
}) {
  const [status, setStatus] = useState(initialStatus)
  const [search, setSearch] = useState(initialSearch)
  // Audience filter state — { logic, filters: [{ field, op, value }] }
  // or null when not in advanced mode.
  const [filter, setFilter] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Client-fetched list (populated when advanced filter is active).
  // null means "use initialContacts from the server"; an array means
  // "we have the API result, show it".
  const [clientContacts, setClientContacts] = useState(null)
  const [count, setCount] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // We're "active" (using the API path) whenever the operator has
  // either added an advanced filter row OR typed in the search box.
  // Status chips alone keep us on the server-rendered path so back
  // navigation + URL sharing keep working. The search box re-fetches
  // because it has no URL counterpart in client mode.
  const filterRowCount = filter?.filters?.length || 0
  const apiActive = filterRowCount > 0

  // Build the body for /api/contacts/search. Memoised so the effect
  // doesn't re-run on every render — it should only re-fire when the
  // composite state changes.
  const body = useMemo(() => ({
    filter: apiActive ? filter : undefined,
    search: search || undefined,
    location_id: locationId,
    limit: 200,
  }), [apiActive, filter, search, locationId])

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/contacts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Search failed')
        return
      }
      // Apply the simple status chip on top of the API result. The
      // chip never goes through the API in v1 — it's a UI concept
      // that pre-dates the audience filter and stays as a quick
      // filter affordance.
      const filtered = status
        ? (json.contacts || []).filter(c => c.lead_status === status)
        : (json.contacts || [])
      setClientContacts(filtered)
      setCount(json.count)
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [body, status])

  // Re-fetch when advanced filter or search text changes. Status chip
  // changes don't trigger a fetch — we filter client-side from the
  // already-loaded list (same reasoning as above).
  useEffect(() => {
    if (!apiActive) {
      setClientContacts(null)
      setCount(null)
      return
    }
    fetchContacts()
  }, [apiActive, fetchContacts])

  // Status filter applied client-side over initialContacts when we're
  // not using the API. This mirrors the previous server-rendered
  // behaviour (URL ?status=… still drives the chip selection).
  const visibleContacts = useMemo(() => {
    if (clientContacts !== null) return clientContacts
    if (!status) return initialContacts
    return initialContacts.filter(c => c.lead_status === status)
  }, [clientContacts, initialContacts, status])

  function clearAdvanced() {
    setFilter(null)
    setShowAdvanced(false)
  }

  return (
    <div>
      {/* Status chips — keep the URL-driven UX so links into a status
          continue to work (and the back button does what you'd expect). */}
      <div className="flex gap-2 mb-5 flex-wrap items-center">
        {STATUSES.map(s => (
          <Link
            key={s}
            href={`/contacts${s ? `?status=${s}` : ''}`}
            onClick={() => setStatus(s)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              status === s
                ? 'border-un1t-white text-un1t-white bg-un1t-gray'
                : 'border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
            }`}
          >
            {s ? s.replace('_', ' ') : 'All'}
          </Link>
        ))}

        <div className="flex-1" />

        <button
          onClick={() => setShowAdvanced(o => !o)}
          className={`text-xs px-3 py-1.5 rounded-md border flex items-center gap-1.5 transition-colors ${
            filterRowCount > 0
              ? 'bg-un1t-white text-un1t-black border-un1t-white'
              : 'border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid'
          }`}
          title="Filter by any contact field"
        >
          <Filter size={12} />
          Advanced filter
          {filterRowCount > 0 && (
            <span className="ml-1 bg-un1t-black/10 px-1.5 py-0.5 rounded-full text-[10px]">
              {filterRowCount}
            </span>
          )}
        </button>

        {filterRowCount > 0 && (
          <button
            onClick={clearAdvanced}
            className="text-xs text-un1t-light hover:text-red-400 flex items-center gap-1"
            title="Clear advanced filter"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Search */}
      <form className="mb-5" onSubmit={(e) => e.preventDefault()}>
        <input
          type="text"
          name="q"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="w-full max-w-md bg-un1t-dark border border-un1t-gray rounded-md px-4 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
        />
      </form>

      {/* Advanced filter panel — only renders when toggled open. */}
      {showAdvanced && (
        <div className="mb-5 bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <AudienceBuilder
            filter={filter}
            onChange={(next) => setFilter(next)}
            audienceCount={apiActive ? count : null}
          />
        </div>
      )}

      {error && (
        <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          {error}
        </div>
      )}

      {loading && (
        <div className="mb-3 text-xs text-un1t-light">Loading…</div>
      )}

      <ContactsTable contacts={visibleContacts} locationId={locationId} />
    </div>
  )
}
