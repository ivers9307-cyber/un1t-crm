'use client'

import { useState, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import DealCard from './DealCard'
import ContactDrawer from './contact/ContactDrawer'

// FUNNEL.1 — funnel taxonomy. Hexes match mig 350 stage rows.
// WAITLIST.1 — the waitlist_* rows are mig 597's manual board at Hatch Street.
// Without them every waitlist column draws the fallback grey, which reads as
// "unconfigured" on the one board where the columns are the whole product.
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
  waitlist_new_enquiry:    '#3B82F6',
  waitlist_no_answer:      '#F59E0B',
  waitlist_interested:     '#10B981',
  waitlist_not_interested: '#52525B',
  waitlist_converted:      '#059669',
}

// Cards with no upcoming class sort first — that's the follow-up list; a booked
// next class means the funnel is working on its own. Stable partition, so a
// lazily-loaded page appended to a column re-partitions the growing set cleanly.
function sortColumn(deals) {
  return [...deals].sort((a, b) =>
    (a.contacts?.next_class_at ? 1 : 0) - (b.contacts?.next_class_at ? 1 : 0))
}

// FUNNEL.1 — a DERIVED board is read-only. Every column there is set by the
// classifier (webhook + nightly cron), so a manual drag would be silently
// overwritten by the next classify pass — showing the operator a move that
// walks back overnight is worse than offering no drag at all, which is why
// drag-drop was removed from this board in the first place.
//
// WAITLIST.3 — a MANUAL board is the exact opposite: the classifier never reads
// or writes a pipelines.mode='manual' board (mig 594's fence), so nothing
// derives its columns and dragging is the ONLY way a card moves. `manual` gates
// every drag handler below, and the same fence is enforced server-side by
// POST /api/deals/[id]/stage, which refuses a derived pipeline outright — the
// board never being draggable is the UI half of one guarantee, not the whole
// of it.
//
// FEAT-PIPELINE-LAZY.1 — the server ships only the first page per column plus a
// per-stage total count; each column lazily fetches more via /api/pipeline/deals
// so the client never receives all (≤10k) open deals at once.
export default function KanbanBoard({ initialStages, initialDeals, stageCounts = {}, view = 'active', manual = false, locationId }) {
  // Accumulated deals per column, seeded from the server's first page.
  const [columnDeals, setColumnDeals] = useState(() => {
    const m = {}
    for (const stage of initialStages) m[stage.id] = initialDeals.filter((d) => d.stage_id === stage.id)
    return m
  })
  const [columnLoading, setColumnLoading] = useState({})

  // Drag state (manual boards only). dragDealId survives the drop because
  // Safari empties dataTransfer on some drop paths; the dataTransfer payload is
  // still set because Firefox refuses to start a drag without one.
  const [dragDealId, setDragDealId] = useState(null)
  const [dropStageId, setDropStageId] = useState(null)
  const [moveError, setMoveError] = useState(null)

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

  // WAITLIST.3 — optimistic move, reconciled by router.refresh() (which
  // re-reads the server-side per-stage totals behind the column badges).
  //
  // ON FAILURE THE CARD GOES BACK. Leaving it in the new column would show the
  // operator a move the database never took — a card that reads "No Answer" to
  // everyone looking at the board while the row still says New Enquiry is worse
  // than one that visibly did not stick. The revert is paired with a plain
  // message: a card silently snapping back is indistinguishable from a fumbled
  // drag, and an operator who cannot tell the difference will assume it worked.
  //
  // Known limit, stated rather than hidden: "Load more" pages by the loaded
  // count, so a moved card can shift the target column's paging by one until
  // the next full load. It self-corrects on reload and never loses a row.
  const moveDeal = useCallback(async (dealId, toStageId) => {
    const from = Object.keys(columnDeals).find((sid) =>
      (columnDeals[sid] || []).some((d) => d.id === dealId))
    if (!from || from === toStageId) return

    const card = (columnDeals[from] || []).find((d) => d.id === dealId)
    if (!card) return

    setMoveError(null)
    setColumnDeals((p) => ({
      ...p,
      [from]: (p[from] || []).filter((d) => d.id !== dealId),
      [toStageId]: [card, ...(p[toStageId] || [])],
    }))

    try {
      const res = await fetch(`/api/deals/${encodeURIComponent(dealId)}/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage_id: toStageId }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'move failed')
      router.refresh()
    } catch {
      setColumnDeals((p) => ({
        ...p,
        [toStageId]: (p[toStageId] || []).filter((d) => d.id !== dealId),
        [from]: [card, ...(p[from] || [])],
      }))
      setMoveError('That move did not save. The card is back where it was, so try again.')
    }
  }, [columnDeals, router])

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
    <>
      {moveError && (
        <div role="status" className="mb-3 text-xs px-2.5 py-1.5 rounded-md bg-red-500/10 text-red-700">
          {moveError}
        </div>
      )}
      <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
        {initialStages.map((stage) => {
          const loaded = sortColumn(columnDeals[stage.id] || [])
          const total = stageCounts[stage.id] ?? loaded.length
          const color = stageColors[stage.slug] || '#6B7280'
          const hasMore = loaded.length < total
          const isDropTarget = manual && dropStageId === stage.id

          // Every handler is manual-only: on a derived board the column is an
          // inert div, exactly as it was before WAITLIST.3.
          const dropProps = manual ? {
            onDragOver: (e) => { e.preventDefault(); setDropStageId(stage.id) },
            onDragLeave: () => setDropStageId((s) => (s === stage.id ? null : s)),
            onDrop: (e) => {
              e.preventDefault()
              const id = dragDealId || e.dataTransfer.getData('text/plain')
              setDropStageId(null)
              setDragDealId(null)
              if (id) moveDeal(id, stage.id)
            },
          } : {}

          return (
            <div
              key={stage.id}
              {...dropProps}
              className={`shrink-0 w-64 bg-un1t-surface rounded-lg border transition-colors ${
                isDropTarget ? 'border-un1t-accent ring-2 ring-un1t-accent' : 'border-un1t-border'
              }`}
            >
              {/* Stage Header — badge is the server-side total, not the loaded count. */}
              <div className="flex items-center gap-2 p-3 border-b border-un1t-border">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                <h3 className="text-xs font-semibold uppercase tracking-wider truncate">{stage.name}</h3>
                <span className="ml-auto text-xs text-un1t-subtle bg-un1t-border px-1.5 rounded">
                  {total}
                </span>
              </div>

              {/* Deal Cards — only the loaded pages are mounted; "Load more" fetches
                  the next page from /api/pipeline/deals and appends it. On a manual
                  board each card sits in a draggable host, which is where the React
                  key lives (it moved off DealCard with the wrapper). */}
              <div className="p-2 space-y-0 min-h-[100px]">
                {loaded.map((deal) => (
                  <div
                    key={deal.id}
                    draggable={manual}
                    onDragStart={manual ? (e) => {
                      setDragDealId(deal.id)
                      setMoveError(null)
                      // Firefox will not start a drag without a payload; Safari
                      // sometimes drops it again, which is why dragDealId exists.
                      e.dataTransfer.setData('text/plain', deal.id)
                      e.dataTransfer.effectAllowed = 'move'
                    } : undefined}
                    onDragEnd={manual ? () => { setDragDealId(null); setDropStageId(null) } : undefined}
                    className={manual ? 'cursor-grab active:cursor-grabbing' : undefined}
                  >
                    <DealCard deal={deal} locationId={locationId} stageName={stage.name} onOpenContact={openContact} manual={manual} />
                  </div>
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
    </>
  )
}
