'use client'

import { useState, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import DealCard from './DealCard'
import ContactDrawer from './contact/ContactDrawer'

// FUNNEL.1 — funnel taxonomy. Hexes match mig 350 stage rows.
const stageColors = {
  new_lead:     '#3B82F6',
  first_class:  '#10B981',
  second_class: '#14B8A6',
  trial_done:   '#F59E0B',
  converted:    '#059669',
  member:       '#64748B',
  pack_member:  '#0891B2',
  classpass:    '#A855F7',
  gympass:      '#F97316',
  cold_lead:    '#52525B',
  dormant:      '#6B7280',
}

// Cards with no upcoming class sort first — that's the follow-up list; a booked
// next class means the funnel is working on its own. Stable partition, so a
// lazily-loaded page appended to a column re-partitions the growing set cleanly.
function sortColumn(deals) {
  return [...deals].sort((a, b) =>
    (a.contacts?.next_class_at ? 1 : 0) - (b.contacts?.next_class_at ? 1 : 0))
}

// FUNNEL.1 — the board is read-only (every column is classifier-derived, so a
// manual drag would be overwritten by the next classify pass).
// FEAT-PIPELINE-LAZY.1 — the server ships only the first page per column plus a
// per-stage total count; each column lazily fetches more via /api/pipeline/deals
// so the client never receives all (≤10k) open deals at once.
export default function KanbanBoard({ initialStages, initialDeals, stageCounts = {}, view = 'active', locationId }) {
  // Accumulated deals per column, seeded from the server's first page.
  const [columnDeals, setColumnDeals] = useState(() => {
    const m = {}
    for (const stage of initialStages) m[stage.id] = initialDeals.filter((d) => d.stage_id === stage.id)
    return m
  })
  const [columnLoading, setColumnLoading] = useState({})

  // DRAWER.5 — the contact slide-over is URL-driven (?contact=<id>) so
  // back-button, refresh and shared links all restore it. Open pushes a
  // history entry (back closes the drawer); ‹ ›-navigation and close
  // replace, so stepping through a column doesn't spam history.
  const router = useRouter()
  const searchParams = useSearchParams()
  const openContactId = searchParams.get('contact')

  const writeContactParam = useCallback((id, { push = false } = {}) => {
    const p = new URLSearchParams(searchParams.toString())
    if (id) p.set('contact', id)
    else p.delete('contact')
    const qs = p.toString()
    const url = qs ? `/pipeline?${qs}` : '/pipeline'
    if (push) router.push(url, { scroll: false })
    else router.replace(url, { scroll: false })
  }, [router, searchParams])

  const openContact = useCallback((id) => writeContactParam(id, { push: true }), [writeContactParam])
  const navigateContact = useCallback((id) => writeContactParam(id), [writeContactParam])
  const closeContact = useCallback(() => writeContactParam(null), [writeContactParam])

  // Lazily fetch the next page for one column and append it.
  const loadMore = useCallback(async (stageId) => {
    setColumnLoading((p) => ({ ...p, [stageId]: true }))
    try {
      const offset = (columnDeals[stageId] || []).length
      const res = await fetch(`/api/pipeline/deals?stage_id=${encodeURIComponent(stageId)}&offset=${offset}&view=${view}`)
      const json = await res.json()
      if (json.success) {
        setColumnDeals((p) => ({ ...p, [stageId]: [...(p[stageId] || []), ...(json.deals || [])] }))
      }
    } catch {
      // best-effort — a failed page leaves the column as-is; the operator can retry.
    } finally {
      setColumnLoading((p) => ({ ...p, [stageId]: false }))
    }
  }, [columnDeals, view])

  // Ordered contact ids for the open contact's column (board render order), so
  // the drawer can step through it. Spans the loaded cards.
  const columnContactIds = useMemo(() => {
    if (!openContactId) return []
    for (const stage of initialStages) {
      const ids = sortColumn(columnDeals[stage.id] || []).map((d) => d.contacts?.id).filter(Boolean)
      if (ids.includes(openContactId)) return ids
    }
    return []
  }, [openContactId, initialStages, columnDeals])

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
      {initialStages.map((stage) => {
        const loaded = sortColumn(columnDeals[stage.id] || [])
        const total = stageCounts[stage.id] ?? loaded.length
        const color = stageColors[stage.slug] || '#6B7280'
        const hasMore = loaded.length < total

        return (
          <div key={stage.id} className="shrink-0 w-64 bg-un1t-surface rounded-lg border border-un1t-border">
            {/* Stage Header — badge is the server-side total, not the loaded count. */}
            <div className="flex items-center gap-2 p-3 border-b border-un1t-border">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <h3 className="text-xs font-semibold uppercase tracking-wider truncate">{stage.name}</h3>
              <span className="ml-auto text-xs text-un1t-subtle bg-un1t-border px-1.5 rounded">
                {total}
              </span>
            </div>

            {/* Deal Cards — only the loaded pages are mounted; "Load more" fetches
                the next page from /api/pipeline/deals and appends it. */}
            <div className="p-2 space-y-0 min-h-[100px]">
              {loaded.map((deal) => (
                <DealCard key={deal.id} deal={deal} locationId={locationId} stageName={stage.name} onOpenContact={openContact} />
              ))}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => loadMore(stage.id)}
                  disabled={columnLoading[stage.id]}
                  className="w-full mt-1 py-1.5 text-[11px] text-un1t-subtle hover:text-un1t-text border border-dashed border-un1t-border rounded-md hover:border-un1t-subtle transition-colors disabled:opacity-50"
                >
                  {columnLoading[stage.id] ? 'Loading…' : `Load more (${loaded.length} of ${total})`}
                </button>
              )}
            </div>
          </div>
        )
      })}

      {openContactId && (
        <ContactDrawer
          contactId={openContactId}
          columnContactIds={columnContactIds}
          locationId={locationId}
          onNavigate={navigateContact}
          onClose={closeContact}
        />
      )}
    </div>
  )
}
