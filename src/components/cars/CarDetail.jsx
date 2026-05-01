'use client'

// Single-page detail view for one car. Sections shown depend on
// status — fields and the action button at the top adapt:
//
//   new       → fill UK + Irish prices, then "Move to Pending"
//   pending   → buyer details, Xero invoice button, UK VAT toggle,
//               document uploads. "Mark Completed" is gated by
//               completionGaps() — UI mirrors the API check.
//   completed → read-only summary

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { ArrowLeft, ChevronRight, Trash2, Check, AlertCircle, Search } from 'lucide-react'
import { completionGaps, profitBreakdown, COST_FIELDS, applyIrishVat, salePriceToExVat, splitIrishPrice, IRISH_VAT_RATE } from '@/lib/cars'

// XeroCard + DocumentsCard + DepositCard only render when the car is
// in pending or completed state. Dynamic-import them so new-status
// car detail loads don't ship the chunks in the initial bundle —
// they fetch on demand the first time a pending car is opened.
const XeroCard = dynamic(() => import('./XeroCard'), { ssr: true })
const DocumentsCard = dynamic(() => import('./DocumentsCard'), { ssr: true })
const DepositCard = dynamic(() => import('./DepositCard'), { ssr: true })

export default function CarDetail({ car: initialCar, liveFxRate = null, fxFetchedAt = null }) {
  const [car, setCar] = useState(initialCar)
  const router = useRouter()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function patch(updates) {
    setBusy(true); setError(null)
    const res = await fetch(`/api/cars/${car.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const j = await res.json()
    setBusy(false)
    if (!j.success) { setError(j.error || 'Failed to save'); return null }
    setCar(c => ({ ...j.data, car_documents: c.car_documents }))
    return j.data
  }

  async function promote(to) {
    setBusy(true); setError(null)
    const res = await fetch(`/api/cars/${car.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    })
    const j = await res.json()
    setBusy(false)
    if (!j.success) { setError(j.error || 'Failed to promote'); return }
    setCar(c => ({ ...j.data, car_documents: c.car_documents }))
    router.refresh()
  }

  async function deleteCar() {
    if (!confirm(`Delete this car (${car.uk_reg || car.vin || 'no reg'})? This is permanent.`)) return
    setBusy(true)
    const res = await fetch(`/api/cars/${car.id}`, { method: 'DELETE' })
    const j = await res.json()
    setBusy(false)
    if (!j.success) { setError(j.error || 'Failed to delete'); return }
    router.push('/cars')
  }

  const gaps = completionGaps(car)

  return (
    <div className="max-w-3xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <Link
          href={car.status === 'completed' ? '/cars/completed' : '/cars/active'}
          className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white"
        >
          <ArrowLeft size={16} /> Back to {car.status === 'completed' ? 'completed' : 'active'}
        </Link>
        <button
          onClick={deleteCar}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs text-un1t-light hover:text-red-500 disabled:opacity-50"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>

      <div className="flex items-baseline justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-bold text-un1t-white">
            {car.make} {car.model} {car.vehicle_year ? `· ${car.vehicle_year}` : ''}
          </h2>
          <p className="text-xs text-un1t-light mt-1">
            {car.uk_reg && <>UK · <span className="text-un1t-white font-mono">{car.uk_reg}</span></>}
            {car.uk_reg && car.irish_reg && '   ·   '}
            {car.irish_reg && <>IE · <span className="text-un1t-white font-mono">{car.irish_reg}</span></>}
            {!car.uk_reg && !car.irish_reg && 'No registration set'}
          </p>
        </div>
        <StatusBadge status={car.status} />
      </div>

      <CarFieldsCard
        car={car}
        patch={patch}
        disabled={car.status === 'completed' || busy}
        liveFxRate={liveFxRate}
        fxFetchedAt={fxFetchedAt}
      />

      {/* New → Pending CTA */}
      {car.status === 'new' && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-un1t-white">Got a buyer?</h3>
            <p className="text-xs text-un1t-light">Move this car to Pending to start the closing checklist.</p>
          </div>
          <button
            onClick={() => promote('pending')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            Move to Pending <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Pending workflow */}
      {(car.status === 'pending' || car.status === 'completed') && (
        <>
          <BuyerCard car={car} patch={patch} disabled={car.status === 'completed' || busy} />
          <DepositCard car={car} setCar={setCar} setError={setError} disabled={car.status === 'completed'} />
          <XeroCard car={car} setCar={setCar} setError={setError} busy={busy} setBusy={setBusy} disabled={car.status === 'completed'} />
          <UkVatRefundCard car={car} patch={patch} disabled={car.status === 'completed' || busy} />
          <DocumentsCard car={car} setCar={setCar} setError={setError} disabled={car.status === 'completed'} />
        </>
      )}

      {/* Pending → Completed CTA + checklist */}
      {car.status === 'pending' && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
          <h3 className="text-sm font-semibold text-un1t-white mb-2">Ready to complete?</h3>
          {gaps.length === 0 ? (
            <button
              onClick={() => promote('completed')}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 disabled:opacity-50"
            >
              <Check size={16} /> Mark completed and archive
            </button>
          ) : (
            <>
              <p className="text-xs text-un1t-light mb-2">{gaps.length} item{gaps.length === 1 ? '' : 's'} outstanding:</p>
              <ul className="text-sm text-amber-500 space-y-1">
                {gaps.map(g => (
                  <li key={g} className="flex items-center gap-2">
                    <AlertCircle size={14} /> {g}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {car.status === 'completed' && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 text-center">
          <p className="text-sm text-green-500 font-semibold">
            <Check size={14} className="inline-block mr-1" /> Completed
            {car.completed_at && ` · ${new Date(car.completed_at).toLocaleDateString()}`}
          </p>
          <button
            onClick={() => promote('pending')}
            disabled={busy}
            className="text-xs text-un1t-light hover:text-un1t-white mt-2 underline"
          >
            Reopen
          </button>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------

function StatusBadge({ status }) {
  const cls = status === 'new'       ? 'bg-blue-500/20 text-blue-400'
            : status === 'pending'   ? 'bg-amber-500/20 text-amber-500'
            :                          'bg-green-500/20 text-green-500'
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs uppercase font-semibold ${cls}`}>
      {status}
    </span>
  )
}

function CarFieldsCard({ car, patch, disabled, liveFxRate, fxFetchedAt }) {
  const breakdown = profitBreakdown(car, liveFxRate)
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Vehicle</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <InlineField label="UK reg"      value={car.uk_reg}        onSave={v => patch({ uk_reg: v })} disabled={disabled} />
          <InlineField label="Irish reg"   value={car.irish_reg}     onSave={v => patch({ irish_reg: v })} disabled={disabled} />
          <InlineField label="VIN"         value={car.vin}           onSave={v => patch({ vin: v })} disabled={disabled} />
          <InlineField label="Make"        value={car.make}          onSave={v => patch({ make: v })} disabled={disabled} />
          <InlineField label="Model"       value={car.model}         onSave={v => patch({ model: v })} disabled={disabled} />
          <InlineField label="Year"        value={car.vehicle_year}  type="number" onSave={v => patch({ vehicle_year: v ? Number(v) : null })} disabled={disabled} />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Prices</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <InlineField label="UK ex-VAT (£)"  value={car.uk_purchase_price_ex_vat} type="number" step="0.01" onSave={v => patch({ uk_purchase_price_ex_vat: v ? Number(v) : null })} disabled={disabled} />
          {/* UK VAT — the amount HMRC owes back. Kept as a reference
              field so we can report on outstanding refunds across the
              fleet. The 'UK VAT refund' toggle further down records
              when it's actually been received. */}
          <InlineField label="UK VAT (£)"     value={car.uk_vat}                   type="number" step="0.01" onSave={v => patch({ uk_vat: v ? Number(v) : null })} disabled={disabled} />
          {/* IE ex-VAT is the source of truth — editing it patches
              both irish_sale_price_ex_vat and irish_sale_price_inc_vat
              (the latter is the sale-price total, displayed as the
              third Irish field below). The remaining two cells show
              the VAT amount and Sale price both derived from this. */}
          <InlineField
            label="IE ex-VAT (€)"
            value={(() => {
              // Show stored ex-VAT directly when present; for legacy
              // rows that only have inc-VAT, show the back-derived
              // value so the operator sees something sensible until
              // they save (which writes both columns).
              const split = splitIrishPrice(car)
              return car.irish_sale_price_ex_vat != null
                ? car.irish_sale_price_ex_vat
                : (split.exVat != null ? split.exVat : '')
            })()}
            type="number"
            step="0.01"
            onSave={v => {
              const exVat = v ? Number(v) : null
              return patch({
                irish_sale_price_ex_vat: exVat,
                irish_sale_price_inc_vat: applyIrishVat(exVat),
              })
            }}
            disabled={disabled}
          />
          <DerivedField
            label="IE VAT (€)"
            value={splitIrishPrice(car).vat}
            hint={`${IRISH_VAT_RATE * 100}% Irish VAT`}
          />
          {/* Sale price is also a valid entry point — saving it
              back-derives ex-VAT so the IE VAT cell and the profit
              calc stay coherent. Either field drives the other. */}
          <InlineField
            label="Sale price (€)"
            value={(() => {
              const split = splitIrishPrice(car)
              return car.irish_sale_price_inc_vat != null
                ? car.irish_sale_price_inc_vat
                : (split.salePrice != null ? split.salePrice : '')
            })()}
            type="number"
            step="0.01"
            onSave={v => {
              const sale = v ? Number(v) : null
              return patch({
                irish_sale_price_inc_vat: sale,
                irish_sale_price_ex_vat: salePriceToExVat(sale),
              })
            }}
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Costs</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {COST_FIELDS.map(c => {
            const sym = c.currency === 'GBP' ? '£' : '€'
            return (
              <InlineField
                key={c.key}
                label={`${c.label} (${sym})`}
                value={car[c.key]}
                type="number"
                step="0.01"
                onSave={v => patch({ [c.key]: v ? Number(v) : null })}
                disabled={disabled}
              />
            )
          })}
        </div>
      </div>

      {breakdown && (
        <div className="bg-un1t-gray/30 border border-un1t-gray rounded-md px-4 py-3 space-y-1">
          <div className="text-sm text-un1t-white">
            Sale €{Math.round(breakdown.saleEur)}
            {' − '}UK ex-VAT £{Math.round(breakdown.ukExVatGbp)} (€{Math.round(breakdown.ukExVatEur)} @ {breakdown.fx.toFixed(4)})
            {breakdown.ancillaryGbp > 0 && (
              <> − UK costs £{Math.round(breakdown.ancillaryGbp)} (€{Math.round(breakdown.ancillaryGbpInEur)})</>
            )}
            {breakdown.ancillaryEur > 0 && (
              <> − IE costs €{Math.round(breakdown.ancillaryEur)}</>
            )}
            {' = '}
            <span className={breakdown.profit >= 0 ? 'text-green-700 font-bold' : 'text-red-600 font-bold'}>
              €{Math.round(breakdown.profit)}
            </span>
          </div>
          <div className="text-xs text-un1t-light">
            {breakdown.isUsingDefaultFx
              ? `FX £→€ ${breakdown.fx} (live rate unavailable — fallback)`
              : breakdown.fxIsCarSnapshot
                ? `FX £→€ ${breakdown.fx.toFixed(4)} · snapshot from car creation`
                : `FX £→€ ${breakdown.fx.toFixed(4)} · auto-updated daily from ECB${fxFetchedAt ? ` (last refresh ${new Date(fxFetchedAt).toLocaleString()})` : ''}`}
          </div>
        </div>
      )}
    </div>
  )
}

function BuyerCard({ car, patch, disabled }) {
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Buyer</h3>
        {!disabled && <XeroContactSearch carId={car.id} onPick={c => patch(c)} />}
      </div>
      <div className="space-y-2">
        <InlineField label="Name"    value={car.buyer_name}    onSave={v => patch({ buyer_name: v })} disabled={disabled} />
        <InlineField label="Email"   value={car.buyer_email}   onSave={v => patch({ buyer_email: v })} disabled={disabled} />
        <InlineField label="Phone"   value={car.buyer_phone}   onSave={v => patch({ buyer_phone: v })} disabled={disabled} />
        <InlineField label="Address" value={car.buyer_address} multiline onSave={v => patch({ buyer_address: v })} disabled={disabled} />
      </div>
    </div>
  )
}

// Live search-as-you-type against the location's Xero org. Type 2+
// chars → debounced fetch → dropdown of matching Xero contacts.
// Picking one patches buyer_name / email / phone / address in a
// single PATCH so the operator doesn't have to copy/paste from
// Xero. Manual entry still works — just don't pick from the list.
function XeroContactSearch({ carId, onPick }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const ref = useRef(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Debounced search — 300ms after typing stops, 2+ chars required.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) { setResults([]); setError(null); return }
    const id = setTimeout(async () => {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/cars/${carId}/xero-contact-search?q=${encodeURIComponent(q)}`)
        const j = await res.json()
        if (j.success) setResults(j.contacts || [])
        else setError(j.error || 'Search failed')
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(id)
  }, [query, open, carId])

  function pick(c) {
    onPick({
      buyer_name: c.name || null,
      buyer_email: c.email || null,
      buyer_phone: c.phone || null,
      buyer_address: c.address || null,
    })
    setOpen(false)
    setQuery('')
    setResults([])
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o)
          // Focus the input on next tick so it works on first click.
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
        className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-un1t-gray/40 text-un1t-light hover:bg-un1t-gray hover:text-un1t-white"
        title="Search existing Xero customers and pre-fill the buyer fields"
      >
        <Search size={11} /> Lookup in Xero
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-un1t-dark border border-un1t-gray rounded-lg shadow-xl z-40">
          <div className="p-2 border-b border-un1t-gray">
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-light"
            />
          </div>
          <div className="max-h-72 overflow-auto">
            {loading && <p className="px-3 py-2 text-xs text-un1t-light">Searching Xero…</p>}
            {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
            {!loading && !error && query.trim().length < 2 && (
              <p className="px-3 py-2 text-xs text-un1t-light">Type 2+ characters to search.</p>
            )}
            {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
              <p className="px-3 py-2 text-xs text-un1t-light">
                No matches. Type the buyer&rsquo;s details manually below — they&rsquo;ll be created in Xero on Issue Invoice.
              </p>
            )}
            {results.map(c => (
              <button
                key={c.id}
                onClick={() => pick(c)}
                className="block w-full text-left px-3 py-2 hover:bg-un1t-gray/40 border-b border-un1t-gray/40 last:border-0"
              >
                <div className="text-sm text-un1t-white truncate">{c.name}</div>
                <div className="text-[11px] text-un1t-light truncate">
                  {c.email || '(no email)'}
                  {c.phone && <> · {c.phone}</>}
                </div>
                {c.address && <div className="text-[11px] text-un1t-mid truncate">{c.address}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function UkVatRefundCard({ car, patch, disabled }) {
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 flex items-center justify-between">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">UK VAT refund</h3>
        <p className="text-xs text-un1t-light mt-1">
          {car.uk_vat_refund_received
            ? `Received ${car.uk_vat_refund_received_at ? new Date(car.uk_vat_refund_received_at).toLocaleDateString() : ''}`
            : 'Toggle on once HMRC has refunded the UK VAT.'}
        </p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => patch({ uk_vat_refund_received: !car.uk_vat_refund_received })}
        className={`w-10 h-5 rounded-full transition-colors disabled:opacity-40 ${car.uk_vat_refund_received ? 'bg-green-500' : 'bg-un1t-gray'}`}
      >
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${car.uk_vat_refund_received ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}


// Display-only field for derived values (IE inc-VAT, computed from
// IE ex-VAT × 1.23). Doesn't accept user input — saving the source
// field above auto-patches this one too.
function DerivedField({ label, value, hint }) {
  return (
    <div className="text-left w-full opacity-90">
      <div className="text-xs text-un1t-light">{label}</div>
      <div className={`text-sm ${value == null || value === '' ? 'text-un1t-mid italic' : 'text-un1t-white'}`}>
        {value == null || value === '' ? '—' : Number(value).toFixed(2)}
      </div>
      {hint && <div className="text-[10px] text-un1t-mid">{hint}</div>}
    </div>
  )
}

// Inline field — shows value as text; click to edit; blur or Enter saves.
function InlineField({ label, value, onSave, type = 'text', step, multiline, disabled }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  function start() {
    if (disabled) return
    setDraft(value ?? '')
    setEditing(true)
  }
  async function commit() {
    setEditing(false)
    const next = draft === '' ? null : draft
    if (next !== (value ?? null)) await onSave(next)
  }

  if (editing) {
    if (multiline) {
      return (
        <div>
          <label className="block text-xs text-un1t-light mb-1">{label}</label>
          <textarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            rows={3}
            className="w-full bg-un1t-black border border-un1t-mid rounded-md px-2 py-1.5 text-sm text-un1t-white focus:outline-none"
          />
        </div>
      )
    }
    return (
      <div>
        <label className="block text-xs text-un1t-light mb-1">{label}</label>
        <input
          autoFocus
          type={type}
          step={step}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          className="w-full bg-un1t-black border border-un1t-mid rounded-md px-2 py-1.5 text-sm text-un1t-white focus:outline-none"
        />
      </div>
    )
  }
  return (
    <button type="button" onClick={start} className="text-left w-full" disabled={disabled}>
      <div className="text-xs text-un1t-light">{label}</div>
      <div className={`text-sm ${value == null || value === '' ? 'text-un1t-mid italic' : 'text-un1t-white'}`}>
        {value == null || value === '' ? '—' : String(value)}
      </div>
    </button>
  )
}
