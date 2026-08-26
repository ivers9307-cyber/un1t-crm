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
import { Filter, X, Save, Bookmark, Trash2 } from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'
import ContactsTable from './ContactsTable'
import { hasMoreContacts, CONTACTS_PAGE_SIZE } from '@/lib/contacts-pagination'

// FUNNEL.1 — chip values are the canonical classifier-derived funnel
// slugs (mig 350): four lead columns, the win column, and the three
// off-funnel pools.
const STATUSES = ['', 'new_lead', 'first_class', 'second_class', 'trial_done',
  'converted', 'member', 'pack_member', 'classpass', 'cold_lead', 'dormant']

export default function ContactsView({
  initialContacts,
  locationId,
  crossoverContext = {},
  listFlags = {},
  initialStatus = '',
  initialSearch = '',
  canMerge = false,
  canDelete = false,
}) {
  const [status, setStatus] = useState(initialStatus)
  const [search, setSearch] = useState(initialSearch)
  // Audience filter state — { logic, filters: [{ field, op, value }] }
  // or null when not in advanced mode.
  const [filter, setFilter] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  // CONTACT-DEDUP — the list shows ONE row per linked person (the group
  // primary). Toggling this on re-queries the API WITHOUT the primary_only
  // filter so the operator can see/reach the folded duplicate accounts.
  const [showDuplicates, setShowDuplicates] = useState(false)

  // Client-fetched list (populated when advanced filter is active).
  // null means "use initialContacts from the server"; an array means
  // "we have the API result, show it".
  const [clientContacts, setClientContacts] = useState(null)
  const [clientCrossoverContext, setClientCrossoverContext] = useState({})
  const [clientListFlags, setClientListFlags] = useState({})
  const [count, setCount] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  // Saved segments — list loaded once on mount. State for the small
  // "Save segment" inline form sits next to it so the inline 'X'
  // dismiss can clear both.
  const [segments, setSegments] = useState([])
  const [activeSegmentId, setActiveSegmentId] = useState(null)
  const [savingSegment, setSavingSegment] = useState(false)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [segmentName, setSegmentName] = useState('')
  const [segmentError, setSegmentError] = useState(null)

  const loadSegments = useCallback(async () => {
    try {
      const res = await fetch(`/api/contacts/segments?location_id=${encodeURIComponent(locationId)}`)
      const json = await res.json()
      if (json.success) setSegments(json.segments || [])
    } catch {
      // Silent — saved segments are an enhancement, not a critical path.
    }
  }, [locationId])

  useEffect(() => { loadSegments() }, [loadSegments])

  function applySegment(segment) {
    setFilter(segment.filter)
    setActiveSegmentId(segment.id)
    setShowAdvanced(true)
  }

  async function saveCurrent() {
    if (!segmentName.trim()) {
      setSegmentError('Name is required')
      return
    }
    setSavingSegment(true)
    setSegmentError(null)
    try {
      const res = await fetch('/api/contacts/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: segmentName.trim(),
          filter: filter || { logic: 'and', filters: [] },
          location_id: locationId,
        }),
      })
      const json = await res.json()
      if (!json.success) {
        setSegmentError(json.error || 'Save failed')
        return
      }
      setSegments(prev => [...prev, json.segment].sort((a, b) => a.name.localeCompare(b.name)))
      setActiveSegmentId(json.segment.id)
      setSegmentName('')
      setShowSaveForm(false)
    } finally {
      setSavingSegment(false)
    }
  }

  async function deleteSegment(segmentId) {
    if (!confirm('Delete this saved segment?')) return
    try {
      const res = await fetch(`/api/contacts/segments/${segmentId}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) {
        alert(json.error || 'Delete failed')
        return
      }
      setSegments(prev => prev.filter(s => s.id !== segmentId))
      if (activeSegmentId === segmentId) setActiveSegmentId(null)
    } catch (e) {
      alert(e.message || 'Network error')
    }
  }

  // We're "active" (using the API path) whenever the operator has
  // either added an advanced filter row OR typed in the search box.
  // Status chips alone keep us on the server-rendered path so back
  // navigation + URL sharing keep working. The search box re-fetches
  // because it has no URL counterpart in client mode.
  const filterRowCount = filter?.filters?.length || 0
  // SEARCH.1 (2026-05-13): search ALSO triggers the API path. Pre-fix,
  // search-only with no advanced filter was client-side-only filtering
  // over the first 200 server-rendered contacts, so a contact outside
  // that 200-row window was unfindable. The API path searches the
  // whole table.
  // showDuplicates also forces the API path: the server-rendered
  // initialContacts are already deduped (is_primary_contact=true), so the
  // only way to surface the folded accounts is to re-query without it.
  const apiActive = filterRowCount > 0 || !!(search?.trim()) || showDuplicates

  // Build the body for /api/contacts/search. Memoised so the effect
  // doesn't re-run on every render — it should only re-fire when the
  // composite state changes.
  //
  // SEARCH.1 fix-up: send `filter` ONLY when there's a real filter
  // object — pre-fix it was gated on `apiActive` which now also turns
  // true on search-only, sending `filter: null` and tripping the
  // zod schema's "Invalid input" reject. The two flags are now
  // independent: apiActive controls whether we hit the API at all,
  // filterRowCount controls whether we send a filter clause.
  const body = useMemo(() => ({
    filter: filterRowCount > 0 ? filter : undefined,
    search: search || undefined,
    location_id: locationId,
    // The contacts list shows crossover deal-holders (owned ∪ deal-at-
    // this-studio); other callers of this route (e.g. the send people-
    // picker) omit this and stay owned-only.
    include_crossovers: true,
    // Fold linked people to one row unless the operator opted to see dupes.
    primary_only: !showDuplicates,
  }), [filterRowCount, filter, search, locationId, showDuplicates])

  // Fetch one page from the search route. `append` accumulates onto `base`
  // (captured at click time) so "Load more" grows the list; a fresh
  // filter/search fetches offset 0 and replaces. The status chip is applied
  // downstream in visibleContacts, so pages are stored raw.
  const fetchPage = useCallback(async ({ offset, append, base }) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/contacts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, limit: CONTACTS_PAGE_SIZE, offset }),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Search failed')
        return
      }
      const incoming = json.contacts || []
      setCount(json.count)
      // Merge, never replace: `append` grows the contact list, so replacing the
    // decoration map would strip the pills off every earlier page.
    setClientCrossoverContext((prev) => (append ? { ...prev, ...(json.crossoverContext || {}) } : (json.crossoverContext || {})))
    setClientListFlags((prev) => (append ? { ...prev, ...(json.listFlags || {}) } : (json.listFlags || {})))
      setClientContacts(append ? [...(base || []), ...incoming] : incoming)
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      if (append) setLoadingMore(false)
      else setLoading(false)
    }
  }, [body])

  // Re-fetch when advanced filter or search text changes. Status chip
  // changes don't trigger a fetch — we filter client-side from the
  // already-loaded list (same reasoning as above).
  useEffect(() => {
    if (!apiActive) {
      setClientContacts(null)
      setCount(null)
      return
    }
    fetchPage({ offset: 0, append: false })
  }, [apiActive, fetchPage])

  // Status filter + search applied client-side over initialContacts
  // when we're not using the API. Mirrors the server-rendered
  // behaviour (URL ?status=… still drives the chip selection) but
  // also makes the search box live-filter as you type without
  // needing the advanced-filter panel open.
  //
  // FUNNEL.1 — the old active_trial chip's ClassPass carve-out is
  // gone: ClassPass PAYG contacts now classify into their own
  // 'classpass' stage, so they never share a chip with trialists.
  const visibleContacts = useMemo(() => {
    let rows = clientContacts !== null ? clientContacts : initialContacts
    if (status) rows = rows.filter(c => c.pipeline_stage_slug === status)
    // SEARCH.1: when apiActive, the API has already done a wider
    // search (name + email + first_name + last_name + phone, multi-
    // token). Re-applying a name/email-only filter client-side would
    // strip phone-matched / surname-matched rows. Only run the
    // client-side search filter when we're using the initial server-
    // rendered list (no advanced filter, no search box value).
    if (search?.trim() && !apiActive) {
      const needle = search.trim().toLowerCase()
      rows = rows.filter(c =>
        (c.name && c.name.toLowerCase().includes(needle))
        || (c.email && c.email.toLowerCase().includes(needle))
      )
    }
    return rows
  }, [clientContacts, initialContacts, status, search, apiActive])

  function clearAdvanced() {
    setFilter(null)
    setShowAdvanced(false)
    setActiveSegmentId(null)
    setShowSaveForm(false)
  }

  // When the user edits filters by hand, drop the "active segment"
  // highlight — they're working on a derived/dirty version now and
  // would need to overwrite the segment to persist their changes.
  function handleFilterChange(next) {
    setFilter(next)
    setActiveSegmentId(null)
  }

  // Use the client-path context when the API result is showing, else the
  // server-rendered initial context. Mirrors the clientContacts vs
  // initialContacts choice in visibleContacts.
  const activeCrossoverContext = clientContacts !== null ? clientCrossoverContext : crossoverContext
  const activeListFlags = clientContacts !== null ? clientListFlags : listFlags

  // Pagination (lift the 200-row cap). rawLoaded is the un-overlaid loaded list
  // — the server initial 200, or the accumulated search pages. "Load more"
  // appends the next page from the search route (which orders identically, so
  // paging past 200 stitches cleanly onto the server-rendered first page).
  const rawLoaded = clientContacts !== null ? clientContacts : initialContacts
  const hasMore = hasMoreContacts({ loadedLength: rawLoaded.length, count })
  function loadMore() {
    const base = clientContacts !== null ? clientContacts : initialContacts
    fetchPage({ offset: base.length, append: true, base })
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
                ? 'border-un1t-text text-un1t-text bg-un1t-border'
                : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted'
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
              ? 'bg-un1t-text text-un1t-bg border-un1t-text'
              : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted'
          }`}
          title="Filter by any contact field"
        >
          <Filter size={12} />
          Advanced filter
          {filterRowCount > 0 && (
            <span className="ml-1 bg-un1t-bg/10 px-1.5 py-0.5 rounded-full text-[10px]">
              {filterRowCount}
            </span>
          )}
        </button>

        {filterRowCount > 0 && (
          <button
            onClick={clearAdvanced}
            className="text-xs text-un1t-subtle hover:text-red-400 flex items-center gap-1"
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
          className="w-full max-w-md bg-un1t-surface border border-un1t-border rounded-md px-4 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
        />
      </form>

      {/* CONTACT-DEDUP — the list shows one profile per person; this reveals
          the folded linked accounts when an operator needs them. */}
      <label className="mb-5 -mt-3 flex items-center gap-2 text-xs text-un1t-subtle cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showDuplicates}
          onChange={(e) => setShowDuplicates(e.target.checked)}
          className="accent-un1t-text"
        />
        Show linked duplicates — the list folds each person down to one profile
      </label>

      {/* Saved segments chip strip — visible whenever any segments
          exist OR the advanced panel is open (so a fresh user can
          discover the feature). Click to apply; X to delete. */}
      {(segments.length > 0 || showAdvanced) && (
        <div className="mb-3 flex gap-2 flex-wrap items-center">
          {segments.length > 0 && (
            <span className="text-[11px] uppercase tracking-wider text-un1t-muted font-semibold flex items-center gap-1">
              <Bookmark size={11} /> Saved
            </span>
          )}
          {segments.map(s => {
            const isActive = activeSegmentId === s.id
            return (
              <span
                key={s.id}
                className={`group inline-flex items-center gap-1 rounded-full border text-xs transition-colors ${
                  isActive
                    ? 'border-un1t-text bg-un1t-border text-un1t-text'
                    : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted'
                }`}
              >
                <button
                  onClick={() => applySegment(s)}
                  className="px-3 py-1.5"
                  title={s.description || 'Apply this saved segment'}
                >
                  {s.name}
                </button>
                <button
                  onClick={() => deleteSegment(s.id)}
                  className="pr-2 text-un1t-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete segment"
                >
                  <Trash2 size={11} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Advanced filter panel — only renders when toggled open. */}
      {showAdvanced && (
        <div className="mb-5 bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
          <AudienceBuilder
            filter={filter}
            onChange={handleFilterChange}
            audienceCount={apiActive ? count : null}
            locationId={locationId}
          />

          {/* Save-as-segment row. Only visible when there's at least
              one filter row to save. */}
          {filterRowCount > 0 && (
            <div className="pt-3 border-t border-un1t-border flex items-center gap-2">
              {showSaveForm ? (
                <>
                  <input
                    type="text"
                    autoFocus
                    value={segmentName}
                    onChange={(e) => setSegmentName(e.target.value)}
                    placeholder="Segment name (e.g. Cold leads with low credits)"
                    className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                    onKeyDown={(e) => { if (e.key === 'Enter') saveCurrent() }}
                  />
                  <button
                    onClick={saveCurrent}
                    disabled={savingSegment}
                    className="text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
                  >
                    {savingSegment ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setShowSaveForm(false); setSegmentName(''); setSegmentError(null) }}
                    className="text-xs text-un1t-subtle hover:text-un1t-text"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowSaveForm(true)}
                  className="text-xs flex items-center gap-1.5 text-un1t-subtle hover:text-un1t-text"
                >
                  <Save size={12} /> Save as segment
                </button>
              )}
            </div>
          )}

          {segmentError && (
            <p className="text-xs text-red-400">{segmentError}</p>
          )}
        </div>
      )}

      {error && (
        <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mb-3 text-xs text-un1t-subtle">Loading…</div>
      )}

      <ContactsTable contacts={visibleContacts} locationId={locationId} crossoverContext={activeCrossoverContext} listFlags={activeListFlags} canMerge={canMerge} canDelete={canDelete} />

      {hasMore && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="px-4 py-2 rounded-md border border-un1t-border text-sm text-un1t-text hover:bg-un1t-border/30 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
          {count !== null && (
            <span className="text-xs text-un1t-subtle">Showing {rawLoaded.length} of {count}</span>
          )}
        </div>
      )}
    </div>
  )
}
