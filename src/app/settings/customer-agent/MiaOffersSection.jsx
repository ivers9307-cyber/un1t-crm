'use client'

// MIAHATCH.4 (Task 14, spec 6.5.1) — "What Mia can sell" at a un1t.online
// studio (Hatch Street). Staff pick the products Mia may offer a customer in
// WhatsApp, drag them into the order she offers them, and give each a one-line
// blurb. Saves through its own endpoint (GET/PUT /api/locations/[id]/mia-offers),
// not the settings Save: the offer list is rows, not a settings key.
//
// A private product (members-only plan) can be listed and is marked Private
// so nobody offers it by accident. An offer whose product has since gone
// inactive is flagged and must be removed before the list saves (the server
// refuses an unsellable product, and silently dropping it would hide the
// change). The Suggested starter is a DRAFT: it fills the list with the
// starter titles that exist at this studio and saves nothing.
//
// Staff-facing copy: no em or en dashes in any label.

import { useState, useEffect, useMemo } from 'react'
import {
  DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { MIA_OFFER_BLURB_MAX } from '@/lib/agent/mia-offer-limits'

// Exact titles, in the order Mia offers them.
export const SUGGESTED_STARTER_TITLES = Object.freeze([
  '1 Class Credit', '5 Class Pack', '10 Class Pack', 'The Monthly Foundation Membership',
])

const PRIVATE_CHIP = 'bg-amber-500/10 text-amber-700'

function euro(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return ''
  const v = n / 100
  return `€${Number.isInteger(v) ? v : v.toFixed(2)}`
}
const priceLine = (o) => `${euro(o.price_cents)}${o.interval ? ` a ${o.interval}` : ''}`

function PrivateChip() {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${PRIVATE_CHIP}`}>Private</span>
}

// A draft row: what the editor holds. `inactive` rows came from the server.
const fromOffer = (o) => ({
  id: o.un1t_product_row_id, title: o.title || 'Unknown product', price_cents: o.price_cents,
  interval: o.interval ?? null, private: !!o.private, blurb: o.blurb || '', inactive: !!o.inactive,
})
const fromProduct = (p) => ({
  id: p.id, title: p.title, price_cents: p.price_cents, interval: p.interval ?? null,
  private: !!p.private, blurb: '', inactive: false,
})

function OfferRow({ row, canEdit, onBlurb, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: !canEdit })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  return (
    <li ref={setNodeRef} style={style} data-testid="offer-row"
      className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
      <div className="flex items-center gap-2">
        {canEdit && (
          <button type="button" {...attributes} {...listeners} aria-label={`Drag ${row.title}`} title="Drag to reorder"
            className="cursor-grab active:cursor-grabbing text-un1t-muted hover:text-un1t-text touch-none">
            <GripVertical size={16} />
          </button>
        )}
        <span data-testid="offer-title" className="text-sm font-medium text-un1t-text">{row.title}</span>
        {row.private && <PrivateChip />}
        <span className="text-xs text-un1t-muted">{priceLine(row)}</span>
        {row.inactive && (
          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-500/10 text-red-600">
            Inactive, Mia will not offer it
          </span>
        )}
        {canEdit && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${row.title}`}
            className="ml-auto text-xs text-un1t-muted hover:text-red-600">
            Remove
          </button>
        )}
      </div>
      <div className="mt-2">
        {canEdit ? (
          <>
            <input aria-label={`Blurb for ${row.title}`} maxLength={MIA_OFFER_BLURB_MAX} value={row.blurb}
              onChange={(e) => onBlurb(e.target.value)}
              placeholder="One line Mia can use to pitch it (optional)"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text" />
            <p className="text-xs text-un1t-muted mt-1 text-right">{row.blurb.length}/{MIA_OFFER_BLURB_MAX}</p>
          </>
        ) : (
          row.blurb && <p className="text-sm text-un1t-subtle">{row.blurb}</p>
        )}
      </div>
    </li>
  )
}

export default function MiaOffersSection({ locationId, canEdit = false }) {
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [rows, setRows] = useState([])
  const [products, setProducts] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const url = `/api/locations/${locationId}/mia-offers`

  function apply(data) {
    setRows((data.offers || []).map(fromOffer))
    setProducts(data.products || [])
  }

  useEffect(() => {
    if (!locationId) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url).then((r) => r.json())
        if (cancelled) return
        if (res?.success && res.data) { apply(res.data); setLoadFailed(false) } else setLoadFailed(true)
      } catch {
        if (!cancelled) setLoadFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [url, locationId])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = useMemo(() => rows.map((r) => r.id), [rows])
  const available = products.filter((p) => !ids.includes(p.id))
  const starterMatches = SUGGESTED_STARTER_TITLES
    .map((t) => available.find((p) => p.title === t))
    .filter(Boolean)
  const hasInactive = rows.some((r) => r.inactive)

  function touch() { setSavedAt(null); setError(null) }
  function add(p) { touch(); setRows((rs) => [...rs, fromProduct(p)]) }
  function remove(id) { touch(); setRows((rs) => rs.filter((r) => r.id !== id)) }
  function setBlurb(id, blurb) { touch(); setRows((rs) => rs.map((r) => (r.id === id ? { ...r, blurb } : r))) }
  function addStarter() { touch(); setRows((rs) => [...rs, ...starterMatches.map(fromProduct)]) }
  function onDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    touch()
    setRows((rs) => {
      const from = rs.findIndex((r) => r.id === active.id)
      const to = rs.findIndex((r) => r.id === over.id)
      return from === -1 || to === -1 ? rs : arrayMove(rs, from, to)
    })
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offers: rows.map((r) => ({ un1t_product_row_id: r.id, blurb: r.blurb.trim() })) }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.success && json.data) { apply(json.data); setSavedAt(Date.now()) }
      else if (json?.error === 'product_not_sellable') {
        setError('One of these products can no longer be sold (inactive, free or not at this studio). Remove it and save again.')
      } else {
        setError(json?.error || 'Could not save. Nothing was changed.')
      }
    } catch {
      setError('Could not save. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border border-un1t-border rounded-lg p-5 mt-6" data-testid="mia-offers-section">
      <h2 className="text-base font-semibold text-un1t-text mb-1">What Mia can sell</h2>
      <p className="text-sm text-un1t-muted mb-4">
        The products Mia can offer a customer who wants to buy, in the order she offers them. Mia sends a
        payment link for the one they pick. Private products are members-only plans: list one only if Mia should offer it.
      </p>

      {loading && <p className="text-sm text-un1t-muted">Loading…</p>}
      {!loading && loadFailed && (
        <p role="alert" className="text-sm text-red-600">
          Could not load the offer list just now, so nothing is shown and nothing can be changed here until it loads.
        </p>
      )}

      {!loading && !loadFailed && (
        <div className="space-y-4">
          {rows.length === 0 && <p className="text-sm text-un1t-muted">No offers yet. Mia will not offer to sell anything.</p>}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {rows.map((r) => (
                  <OfferRow key={r.id} row={r} canEdit={canEdit}
                    onBlurb={(v) => setBlurb(r.id, v)} onRemove={() => remove(r.id)} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          {canEdit && (
            <div data-testid="offer-picker" className="space-y-2">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-medium text-un1t-text">Add a product</h3>
                <button type="button" onClick={addStarter} disabled={starterMatches.length === 0}
                  className="text-xs underline text-un1t-subtle hover:text-un1t-text disabled:opacity-50 disabled:no-underline">
                  Suggested starter
                </button>
              </div>
              {available.length === 0 ? (
                <p className="text-xs text-un1t-muted">Every active product is already listed.</p>
              ) : (
                <ul className="space-y-1">
                  {available.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <button type="button" onClick={() => add(p)} aria-label={`Add ${p.title}`}
                        className="rounded border border-un1t-border px-2 py-0.5 text-xs text-un1t-text hover:bg-un1t-border/40">
                        Add
                      </button>
                      <span className="text-un1t-text">{p.title}</span>
                      {p.private && <PrivateChip />}
                      <span className="text-xs text-un1t-muted">{priceLine(p)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {hasInactive && canEdit && (
            <p className="text-xs text-un1t-muted">Remove the inactive offers to save.</p>
          )}
          {canEdit && (
            <div>
              <button type="button" onClick={save} disabled={saving || hasInactive}
                className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
              {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
