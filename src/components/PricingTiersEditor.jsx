'use client'
// PricingTiersEditor — TIERS.1. Rows of pricing tiers (early bird, capacity
// tiers, a group price) in the ORDER they are tried: name, price (€), limit
// (people), from, until, min people. Emits the race_events.pricing_tiers
// shape (cents, ISO instants, nulls); ids are minted here. Shared by the host
// form (dark) and the staff RaceEventForm (light): only the surface differs.

import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { HOST_LABEL, HOST_WELL, HOST_HINT, HOST_INPUT } from '@/components/host/host-ui'
import { MAX_TIERS } from '@/lib/pricing-tiers'

const blank = () => ({ id: `tier-${Math.random().toString(36).slice(2, 10)}`, name: '', price_cents: 0, capacity: null, starts_at: null, ends_at: null, min_people: null })

/** "2026-12-01T00:00" (datetime-local, browser zone) → ISO instant, '' → null. */
function localToIso(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
/** ISO instant → datetime-local value in the browser zone, null → ''. */
function isoToLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null }

export default function PricingTiersEditor({ value, onChange, dark = false }) {
  const tiers = Array.isArray(value) ? value : []
  const input = dark
    ? HOST_INPUT
    : 'w-full bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-2 text-sm text-un1t-text'
  const label = dark ? `${HOST_LABEL} mb-1` : 'block text-[11px] text-un1t-subtle mb-1'
  const ghost = dark ? 'text-host-hint hover:text-host-text' : 'text-un1t-subtle hover:text-un1t-text'
  const card = dark ? HOST_WELL : 'rounded-md border border-un1t-border bg-un1t-surface p-3'
  const hint = dark ? HOST_HINT : 'text-[11px] text-un1t-muted'

  const update = (i, patch) => onChange(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const remove = (i) => onChange(tiers.filter((_, j) => j !== i))
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= tiers.length) return
    const next = [...tiers]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {tiers.map((t, i) => (
        <div key={t.id} className={card}>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <div className="col-span-2">
              <label htmlFor={`${t.id}-name`} className={label}>Tier {i + 1} name</label>
              <input id={`${t.id}-name`} type="text" maxLength={60} value={t.name || ''} onChange={(e) => update(i, { name: e.target.value })} placeholder="Early bird" className={input} />
            </div>
            <div>
              <label htmlFor={`${t.id}-price`} className={label}>Tier {i + 1} price (€)</label>
              <input id={`${t.id}-price`} type="number" min={0} step="0.01" value={t.price_cents != null ? (t.price_cents / 100).toString() : ''} onChange={(e) => update(i, { price_cents: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)) })} className={input} />
            </div>
            <div>
              <label htmlFor={`${t.id}-cap`} className={label}>Tier {i + 1} limit (people)</label>
              <input id={`${t.id}-cap`} type="number" min={1} step={1} value={t.capacity ?? ''} onChange={(e) => update(i, { capacity: intOrNull(e.target.value) })} placeholder="No limit" className={input} />
            </div>
            <div>
              <label htmlFor={`${t.id}-min`} className={label}>Tier {i + 1} min people</label>
              <input id={`${t.id}-min`} type="number" min={2} max={50} step={1} value={t.min_people ?? ''} onChange={(e) => update(i, { min_people: intOrNull(e.target.value) })} placeholder="Any" className={input} />
            </div>
            <div className="flex items-center gap-1 justify-end">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move tier ${i + 1} up`} className={`p-1.5 ${ghost} disabled:opacity-30`}><ArrowUp size={14} /></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === tiers.length - 1} aria-label={`Move tier ${i + 1} down`} className={`p-1.5 ${ghost} disabled:opacity-30`}><ArrowDown size={14} /></button>
              <button type="button" onClick={() => remove(i)} aria-label={`Remove tier ${i + 1}`} className={`p-1.5 ${ghost}`}><X size={14} /></button>
            </div>
          </div>
          <div className={dark ? 'grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2' : 'grid grid-cols-2 gap-2 mt-2'}>
            <div>
              <label htmlFor={`${t.id}-from`} className={label}>Tier {i + 1} from</label>
              <input id={`${t.id}-from`} type="datetime-local" value={isoToLocal(t.starts_at)} onChange={(e) => update(i, { starts_at: localToIso(e.target.value) })} className={input} />
            </div>
            <div>
              <label htmlFor={`${t.id}-until`} className={label}>Tier {i + 1} until</label>
              <input id={`${t.id}-until`} type="datetime-local" value={isoToLocal(t.ends_at)} onChange={(e) => update(i, { ends_at: localToIso(e.target.value) })} className={input} />
            </div>
          </div>
        </div>
      ))}
      {tiers.length < MAX_TIERS && (
        <button type="button" onClick={() => onChange([...tiers, blank()])} className={`text-sm underline underline-offset-2 ${ghost}`}>
          + Add a tier
        </button>
      )}
      <p className={hint}>
        Tiers are tried in order; a booking gets the first one that is open, has room for everyone in it, and fits its size. The limit counts people and only tier bookings use it up. A tier replaces the standard price; member pricing is unaffected.
      </p>
    </div>
  )
}
