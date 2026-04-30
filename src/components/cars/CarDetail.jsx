'use client'

// Single-page detail view for one car. Sections shown depend on
// status — fields and the action button at the top adapt:
//
//   new       → fill UK + Irish prices, then "Move to Pending"
//   pending   → buyer details, Xero invoice button, UK VAT toggle,
//               document uploads. "Mark Completed" is gated by
//               completionGaps() — UI mirrors the API check.
//   completed → read-only summary

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ChevronRight, Trash2, FileText, Upload, Check, X, AlertCircle, Receipt } from 'lucide-react'
import { ALL_DOCUMENT_TYPES, REQUIRED_DOCUMENT_TYPES, completionGaps, estimatedProfit, totalAncillaryCosts, COST_FIELDS } from '@/lib/cars'

export default function CarDetail({ car: initialCar }) {
  const [car, setCar] = useState(initialCar)
  const router = useRouter()
  const [savingField, setSavingField] = useState(null)
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

  const profit = estimatedProfit(car)
  const gaps = completionGaps(car)

  return (
    <div className="max-w-3xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <Link href={`/cars/${car.status}`} className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white">
          <ArrowLeft size={16} /> Back to {car.status}
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

      <CarFieldsCard car={car} patch={patch} disabled={car.status === 'completed' || busy} />

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

function CarFieldsCard({ car, patch, disabled }) {
  const profit = estimatedProfit(car)
  const ancillary = totalAncillaryCosts(car)
  const sale = Number(car.irish_sale_price_ex_vat || 0)
  const cost = Number(car.uk_purchase_price_ex_vat || 0)
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <InlineField label="UK ex-VAT (£)"  value={car.uk_purchase_price_ex_vat} type="number" step="0.01" onSave={v => patch({ uk_purchase_price_ex_vat: v ? Number(v) : null })} disabled={disabled} />
          <InlineField label="UK VAT (£)"     value={car.uk_vat}                   type="number" step="0.01" onSave={v => patch({ uk_vat: v ? Number(v) : null })} disabled={disabled} />
          <InlineField label="IE inc-VAT (€)" value={car.irish_sale_price_inc_vat} type="number" step="0.01" onSave={v => patch({ irish_sale_price_inc_vat: v ? Number(v) : null })} disabled={disabled} />
          <InlineField label="IE ex-VAT (€)"  value={car.irish_sale_price_ex_vat}  type="number" step="0.01" onSave={v => patch({ irish_sale_price_ex_vat: v ? Number(v) : null })} disabled={disabled} />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Costs</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {COST_FIELDS.filter(c => !c.hasLabelField).map(c => (
            <InlineField
              key={c.key}
              label={`${c.label} (€)`}
              value={car[c.key]}
              type="number"
              step="0.01"
              onSave={v => patch({ [c.key]: v ? Number(v) : null })}
              disabled={disabled}
            />
          ))}
        </div>
        {/* Additional cost gets a label + value pair */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <div className="md:col-span-3">
            <InlineField
              label="Additional cost label"
              value={car.additional_costs_label}
              onSave={v => patch({ additional_costs_label: v })}
              disabled={disabled}
            />
          </div>
          <InlineField
            label={`${car.additional_costs_label || 'Additional'} (€)`}
            value={car.additional_costs}
            type="number"
            step="0.01"
            onSave={v => patch({ additional_costs: v ? Number(v) : null })}
            disabled={disabled}
          />
        </div>
      </div>

      {profit != null && (
        <div className="text-xs text-un1t-light bg-black/30 rounded-md px-3 py-2">
          {ancillary > 0 ? (
            <>
              Sale ex-VAT €{Math.round(sale)} − Purchase ex-VAT €{Math.round(cost)} − Costs €{Math.round(ancillary)} ={' '}
            </>
          ) : (
            <>Estimated profit (ex-VAT both sides): </>
          )}
          <span className={profit >= 0 ? 'text-green-500 font-semibold' : 'text-red-400 font-semibold'}>€{Math.round(profit)}</span>
        </div>
      )}
    </div>
  )
}

function BuyerCard({ car, patch, disabled }) {
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Buyer</h3>
      <div className="space-y-2">
        <InlineField label="Name"    value={car.buyer_name}    onSave={v => patch({ buyer_name: v })} disabled={disabled} />
        <InlineField label="Email"   value={car.buyer_email}   onSave={v => patch({ buyer_email: v })} disabled={disabled} />
        <InlineField label="Phone"   value={car.buyer_phone}   onSave={v => patch({ buyer_phone: v })} disabled={disabled} />
        <InlineField label="Address" value={car.buyer_address} multiline onSave={v => patch({ buyer_address: v })} disabled={disabled} />
      </div>
    </div>
  )
}

function XeroCard({ car, setCar, setError, busy, setBusy, disabled }) {
  async function issue() {
    setBusy(true); setError(null)
    const res = await fetch(`/api/cars/${car.id}/issue-xero-invoice`, { method: 'POST' })
    const j = await res.json()
    setBusy(false)
    if (!j.success) { setError(j.error || 'Failed'); return }
    setCar(c => ({ ...c, ...j.data }))
  }

  const issued = !!car.xero_invoice_id
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Customer invoice (Xero)</h3>
        {issued ? (
          <p className="text-sm text-un1t-white mt-1">
            <Check size={14} className="inline-block text-green-500 mr-1" />
            Issued · invoice {car.xero_invoice_number || car.xero_invoice_id}
            {car.xero_invoice_url && (
              <> · <a href={car.xero_invoice_url} target="_blank" rel="noreferrer" className="text-un1t-white underline">open in Xero</a></>
            )}
          </p>
        ) : (
          <p className="text-xs text-un1t-light mt-1">
            Issues a Xero invoice for the buyer using the Irish inc-VAT sale price.
            {!process.env.NEXT_PUBLIC_XERO_CONFIGURED && (
              <span className="block text-amber-500 mt-1">
                Xero connection not yet configured — button returns a placeholder error until OAuth is wired up.
              </span>
            )}
          </p>
        )}
      </div>
      <button
        onClick={issue}
        disabled={busy || disabled || issued}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-un1t-white text-un1t-black text-xs font-semibold hover:bg-un1t-accent disabled:opacity-50 shrink-0"
      >
        <Receipt size={14} /> {issued ? 'Issued' : 'Issue invoice'}
      </button>
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

function DocumentsCard({ car, setCar, setError, disabled }) {
  const fileRef = useRef(null)
  const [uploadingType, setUploadingType] = useState(null)

  async function upload(type, file) {
    setUploadingType(type); setError(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('doc_type', type)
    const res = await fetch(`/api/cars/${car.id}/documents`, { method: 'POST', body: fd })
    const j = await res.json()
    setUploadingType(null)
    if (!j.success) { setError(j.error || 'Upload failed'); return }
    setCar(c => ({ ...c, car_documents: [...(c.car_documents || []), j.data] }))
  }

  async function open(docId) {
    const res = await fetch(`/api/cars/${car.id}/documents/${docId}`)
    const j = await res.json()
    if (j.success && j.data?.url) window.open(j.data.url, '_blank')
    else setError(j.error || 'Failed to fetch link')
  }

  async function remove(docId) {
    if (!confirm('Remove this document?')) return
    const res = await fetch(`/api/cars/${car.id}/documents/${docId}`, { method: 'DELETE' })
    const j = await res.json()
    if (!j.success) { setError(j.error || 'Failed'); return }
    setCar(c => ({ ...c, car_documents: (c.car_documents || []).filter(d => d.id !== docId) }))
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Documents & invoices</h3>
      <div className="space-y-2">
        {ALL_DOCUMENT_TYPES.map(t => {
          const docs = (car.car_documents || []).filter(d => d.doc_type === t.key)
          const required = REQUIRED_DOCUMENT_TYPES.some(r => r.key === t.key)
          return (
            <div key={t.key} className="border border-un1t-gray rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium text-un1t-white">{t.label}</span>
                  {required && (
                    <span className={`ml-2 text-[10px] uppercase ${docs.length ? 'text-green-500' : 'text-amber-500'}`}>
                      {docs.length ? 'Uploaded' : 'Required'}
                    </span>
                  )}
                </div>
                <UploadOne disabled={disabled || uploadingType === t.key} loading={uploadingType === t.key} onPick={f => upload(t.key, f)} />
              </div>
              {docs.length > 0 && (
                <div className="space-y-1">
                  {docs.map(d => (
                    <div key={d.id} className="flex items-center justify-between text-xs">
                      <button onClick={() => open(d.id)} className="text-un1t-white hover:underline truncate text-left flex-1 inline-flex items-center gap-1.5">
                        <FileText size={12} /> {d.filename}
                      </button>
                      {!disabled && (
                        <button onClick={() => remove(d.id)} className="text-un1t-light hover:text-red-500 ml-2">
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UploadOne({ disabled, loading, onPick }) {
  const inputRef = useRef(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="image/*,application/pdf"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-un1t-gray/40 text-un1t-white text-xs hover:bg-un1t-gray/60 disabled:opacity-50"
      >
        <Upload size={12} /> {loading ? 'Uploading…' : 'Upload'}
      </button>
    </>
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
