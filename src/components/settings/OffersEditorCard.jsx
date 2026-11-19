'use client'

// OFFERSEDIT.1 — the studio's sale offers: list, create and edit. Reads and
// writes /api/locations/[id]/offers. Owners and masters edit (the API says
// so in can_edit); everyone else who sees Offer sales reads. An offer that
// could not be sold shows why, and the API refuses to make it active.
import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, AlertTriangle, Loader2 } from 'lucide-react'
import { Button, Modal, Field } from '@/components/ui'
import { isoToLocalDatetime, localDatetimeToIso } from '@/lib/datetime-local'

const CATEGORY_LABELS = { membership: 'Membership', class_pack: 'Class pack', gift_card: 'Gift card' }
const input = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
const euro = (c) => (Number.isFinite(c) ? `€${(c / 100).toFixed(2)}` : '')

const EMPTY = {
  name: '', category: 'class_pack', bonus_headline: '', description: '', fine_print: '',
  price: '', active: false, starts_at: '', ends_at: '', sort: '0', stock_limit: '', un1t_product_id: '',
}

function toForm(o) {
  return {
    name: o.name, category: o.category, bonus_headline: o.bonus_headline, description: o.description || '',
    fine_print: o.fine_print || '', price: (o.price_cents / 100).toFixed(2), active: o.active,
    starts_at: o.starts_at ? isoToLocalDatetime(o.starts_at) : '', ends_at: o.ends_at ? isoToLocalDatetime(o.ends_at) : '',
    sort: String(o.sort ?? 0), stock_limit: o.stock_limit == null ? '' : String(o.stock_limit), un1t_product_id: o.un1t_product_id || '',
  }
}

/** The body the API takes, from the form. Exported for tests. */
export function bodyFromForm(f) {
  return {
    name: f.name.trim(), category: f.category, bonus_headline: f.bonus_headline.trim(),
    description: f.description, fine_print: f.fine_print,
    price_cents: Math.round(Number(f.price) * 100),
    active: !!f.active,
    ...(f.starts_at ? { starts_at: localDatetimeToIso(f.starts_at) } : {}),
    ends_at: f.ends_at ? localDatetimeToIso(f.ends_at) : null,
    sort: Number(f.sort) || 0,
    stock_limit: f.stock_limit === '' ? null : Number(f.stock_limit),
    un1t_product_id: f.un1t_product_id || null,
  }
}

export default function OffersEditorCard({ locationId }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [editing, setEditing] = useState(null) // null | 'new' | offer

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const r = await fetch(`/api/locations/${locationId}/offers`)
      const j = await r.json()
      if (!r.ok || j.success === false) setState({ loading: false, error: j.error || `Could not load offers (${r.status})`, data: null })
      else setState({ loading: false, error: null, data: j.data })
    } catch (e) {
      setState({ loading: false, error: e.message || 'Network error', data: null })
    }
  }, [locationId])
  useEffect(() => { load() }, [load])

  const { loading, error, data } = state
  if (loading && !data) return <p className="text-sm text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading offers…</p>
  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>

  const canEdit = !!data?.can_edit
  return (
    <div className="space-y-4">
      {canEdit && (
        <Button type="button" icon={Plus} onClick={() => setEditing('new')}>New offer</Button>
      )}
      {!canEdit && <p className="text-xs text-un1t-subtle">Only owners and masters can change offers.</p>}
      {data.offers.length === 0 ? (
        <p className="text-sm text-un1t-subtle">No offers yet.</p>
      ) : (
        <ul className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border">
          {data.offers.map((o) => (
            <li key={o.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-un1t-text">{o.name}</div>
                <div className="text-xs text-un1t-subtle">
                  {CATEGORY_LABELS[o.category] || o.category} · {euro(o.price_cents)} · /{o.slug}
                </div>
                {o.problems?.map((p) => (
                  <div key={p.code} className="text-xs text-amber-700 inline-flex items-center gap-1 mt-1">
                    <AlertTriangle size={12} /> {p.message}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${o.active ? 'bg-emerald-500/10 text-emerald-700' : 'bg-slate-500/10 text-slate-600'}`}>
                  {o.active ? 'Active' : 'Off'}
                </span>
                {canEdit && (
                  <button type="button" onClick={() => setEditing(o)} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1" aria-label={`Edit ${o.name}`}>
                    <Pencil size={12} /> Edit
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <OfferForm
          locationId={locationId}
          offer={editing === 'new' ? null : editing}
          products={data.products}
          un1tStudio={data.platform === 'un1t_online'}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function OfferForm({ locationId, offer, products, un1tStudio, onClose, onSaved }) {
  const [f, setF] = useState(offer ? toForm(offer) : EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const product = products.find((p) => p.un1t_id === f.un1t_product_id) || null
  const priceCents = Math.round(Number(f.price) * 100)
  const mismatch = product && Number.isFinite(priceCents) && product.price_cents !== priceCents
  const needsProduct = un1tStudio && f.category !== 'gift_card'

  async function save(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const url = offer ? `/api/locations/${locationId}/offers/${offer.id}` : `/api/locations/${locationId}/offers`
      const r = await fetch(url, { method: offer ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyFromForm(f)) })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.issues?.[0]?.message || j.error || `Could not save (${r.status})`)
        setBusy(false)
        return
      }
      onSaved()
    } catch (err) {
      setError(err.message || 'Network error'); setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={offer ? `Edit ${offer.name}` : 'New offer'} size="lg">
      <form onSubmit={save} className="space-y-3">
        <Field id="offer-name" label="Name" required>{(p) => <input {...p} className={input} value={f.name} onChange={set('name')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="offer-category" label="Kind">
            {(p) => (
              <select {...p} className={input} value={f.category} onChange={set('category')}>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            )}
          </Field>
          <Field id="offer-price" label="Price (€)" required>{(p) => <input {...p} type="number" min="0.01" step="0.01" className={input} value={f.price} onChange={set('price')} />}</Field>
        </div>
        <Field id="offer-bonus" label="Bonus headline" required hint="The line buyers see first, e.g. “10 classes free”.">{(p) => <input {...p} className={input} value={f.bonus_headline} onChange={set('bonus_headline')} />}</Field>
        <Field id="offer-description" label="Description">{(p) => <textarea {...p} rows={3} className={input} value={f.description} onChange={set('description')} />}</Field>
        <Field id="offer-fine-print" label="Fine print">{(p) => <textarea {...p} rows={2} className={input} value={f.fine_print} onChange={set('fine_print')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="offer-starts" label="On sale from" hint="Your device's time. Blank = now.">{(p) => <input {...p} type="datetime-local" className={input} value={f.starts_at} onChange={set('starts_at')} />}</Field>
          <Field id="offer-ends" label="On sale until" hint="Blank = no end date.">{(p) => <input {...p} type="datetime-local" className={input} value={f.ends_at} onChange={set('ends_at')} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field id="offer-stock" label="Stock limit" hint="Blank = unlimited.">{(p) => <input {...p} type="number" min="1" className={input} value={f.stock_limit} onChange={set('stock_limit')} />}</Field>
          <Field id="offer-sort" label="Order on the page">{(p) => <input {...p} type="number" min="0" className={input} value={f.sort} onChange={set('sort')} />}</Field>
        </div>
        {(needsProduct || f.un1t_product_id) && (
          <Field id="offer-product" label="un1t.online product" hint={needsProduct ? 'Memberships and class packs here are sold through un1t.online.' : 'Only a membership or class pack can carry a product.'}>
            {(p) => (
              <select {...p} className={input} value={f.un1t_product_id} onChange={set('un1t_product_id')}>
                <option value="">None</option>
                {products.map((pr) => <option key={pr.un1t_id} value={pr.un1t_id}>{pr.title || pr.un1t_id} · {euro(pr.price_cents)}</option>)}
              </select>
            )}
          </Field>
        )}
        {mismatch && (
          <p className="text-xs text-amber-700 inline-flex items-center gap-1">
            <AlertTriangle size={12} /> The un1t.online product costs {euro(product.price_cents)}; buyers are turned away until the prices agree.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm text-un1t-text">
          <input type="checkbox" checked={f.active} onChange={set('active')} /> Active (on the offers page)
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>{offer ? 'Save' : 'Create offer'}</Button>
        </div>
      </form>
    </Modal>
  )
}
