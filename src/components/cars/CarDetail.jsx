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
import { ArrowLeft, ChevronRight, Trash2, FileText, Upload, Check, X, AlertCircle, Receipt, Send, RefreshCw, FileDown } from 'lucide-react'
import { ALL_DOCUMENT_TYPES, REQUIRED_DOCUMENT_TYPES, completionGaps, profitBreakdown, COST_FIELDS, applyIrishVat, salePriceToExVat, splitIrishPrice, IRISH_VAT_RATE, DEFAULT_GBP_TO_EUR } from '@/lib/cars'

export default function CarDetail({ car: initialCar, liveFxRate = null, fxFetchedAt = null }) {
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
  // Mirror the server-side validation in src/lib/xero/invoices.js
  // so the UI can disable the button + show what's missing without
  // a round-trip.
  function missingFields(c) {
    const missing = []
    if (!c.buyer_name?.trim()) missing.push('buyer name')
    if (!c.buyer_email?.trim()) missing.push('buyer email')
    const exVat = Number(c.irish_sale_price_ex_vat || 0)
    if (!Number.isFinite(exVat) || exVat <= 0) missing.push('IE ex-VAT sale price')
    return missing
  }

  function applyInvoiceToCar(inv) {
    setCar(c => ({
      ...c,
      xero_invoice_id: inv.invoiceId || null,
      xero_invoice_number: inv.invoiceNumber || null,
      xero_invoice_url: inv.invoiceUrl || null,
      xero_invoice_online_url: inv.onlineInvoiceUrl || null,
      xero_invoice_pdf_path: inv.pdfPath || null,
      xero_invoice_amount: inv.amount ?? null,
      xero_invoice_branding_id: inv.brandingThemeId || null,
      xero_invoice_emailed_at: inv.emailedAt || null,
      xero_invoice_issued_at: inv.issuedAt || null,
    }))
  }

  async function issue() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/cars/${car.id}/issue-xero-invoice`, { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Failed to issue invoice'); return }
      applyInvoiceToCar(j.invoice || {})
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function voidAndReissue() {
    const oldAmount = Number(car.xero_invoice_amount || 0)
    const newAmount = Number(car.irish_sale_price_ex_vat || 0)
    const ok = confirm(
      `This will VOID invoice ${car.xero_invoice_number || car.xero_invoice_id} ` +
      `(€${oldAmount.toFixed(2)}) in Xero and create a new invoice ` +
      `for €${newAmount.toFixed(2)}. The old invoice stays in Xero's history under VOIDED.\n\n` +
      `Proceed?`
    )
    if (!ok) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/cars/${car.id}/void-xero-invoice?reissue=true`, { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Void & reissue failed'); return }
      applyInvoiceToCar(j.invoice || {})
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function viewPdf() {
    if (!car.xero_invoice_pdf_path) return
    // Reuse the same /documents/[id] proxy? It expects a car_documents
    // row id. The PDF lives in storage at xero_invoice_pdf_path —
    // signed URL via the dedicated endpoint:
    const res = await fetch(`/api/cars/${car.id}/xero-invoice-pdf`)
    const j = await res.json()
    if (j.success && j.url) window.open(j.url, '_blank')
    else setError(j.error || 'Failed to open PDF')
  }

  const issued = !!car.xero_invoice_id
  const missing = missingFields(car)
  const issuedAmount = Number(car.xero_invoice_amount || 0)
  const currentAmount = Number(car.irish_sale_price_ex_vat || 0)
  const drift = issued && Number.isFinite(issuedAmount) && Number.isFinite(currentAmount)
    && Math.abs(issuedAmount - currentAmount) > 0.005

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Customer invoice (Xero)</h3>
          {issued ? (
            <div className="text-sm text-un1t-white mt-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Check size={14} className="inline-block text-green-500 mr-1" />
                <span>Issued · {car.xero_invoice_number || car.xero_invoice_id} · €{issuedAmount.toFixed(2)}</span>
                {/* Paid status from Xero webhook (mig 040). PAID = green chip,
                    VOIDED = red, anything else (DRAFT/SUBMITTED/AUTHORISED) = subtle. */}
                {car.xero_invoice_paid_at
                  ? <span className="text-[10px] uppercase font-semibold bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full" title={`Paid ${new Date(car.xero_invoice_paid_at).toLocaleString()}${car.xero_invoice_amount_paid ? ` · €${Number(car.xero_invoice_amount_paid).toFixed(2)}` : ''}`}>Paid</span>
                  : car.xero_invoice_status === 'VOIDED'
                    ? <span className="text-[10px] uppercase font-semibold bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">Voided</span>
                    : car.xero_invoice_status
                      ? <span className="text-[10px] uppercase font-semibold bg-un1t-gray/40 text-un1t-light px-2 py-0.5 rounded-full">{car.xero_invoice_status}</span>
                      : <span className="text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">Awaiting payment</span>}
              </div>
              <div className="text-xs text-un1t-light flex flex-wrap gap-x-3 gap-y-1">
                {car.xero_invoice_url && (
                  <a href={car.xero_invoice_url} target="_blank" rel="noreferrer" className="hover:text-un1t-white underline inline-flex items-center gap-1">
                    Open in Xero
                  </a>
                )}
                {car.xero_invoice_pdf_path && (
                  <button onClick={viewPdf} className="hover:text-un1t-white underline inline-flex items-center gap-1">
                    <FileDown size={11} /> View PDF
                  </button>
                )}
                {car.xero_invoice_online_url && (
                  <a href={car.xero_invoice_online_url} target="_blank" rel="noreferrer" className="hover:text-un1t-white underline">Customer pay link</a>
                )}
                {car.xero_invoice_emailed_at
                  ? <span className="text-green-500">Emailed to buyer</span>
                  : <span className="text-amber-500">Not emailed</span>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-un1t-light mt-1 space-y-1">
              <p>
                Pushes a sales invoice to Xero (IE 23% VAT, &ldquo;Car&rdquo; branding theme),
                emails it to the buyer, and saves a PDF copy.
              </p>
              {missing.length > 0 && (
                <p className="text-amber-500">
                  <AlertCircle size={11} className="inline-block mr-1 mb-0.5" />
                  Need: {missing.join(', ')}.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 shrink-0 items-end">
          {!issued ? (
            <button
              onClick={issue}
              disabled={busy || disabled || missing.length > 0}
              title={missing.length ? `Missing: ${missing.join(', ')}` : ''}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-un1t-white text-un1t-black text-xs font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              <Receipt size={14} /> Issue invoice
            </button>
          ) : drift ? (
            <button
              onClick={voidAndReissue}
              disabled={busy || disabled}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-400 text-xs font-semibold hover:bg-amber-500/30 disabled:opacity-50"
              title={`Sale price changed from €${issuedAmount.toFixed(2)} to €${currentAmount.toFixed(2)}`}
            >
              <RefreshCw size={14} /> Void & reissue
            </button>
          ) : (
            <span className="text-[10px] uppercase text-green-500 px-2 py-1">Up to date</span>
          )}
        </div>
      </div>

      {drift && (
        <div className="mt-3 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md p-2">
          <AlertCircle size={12} className="inline-block mr-1 mb-0.5" />
          Sale price (€{currentAmount.toFixed(2)}) differs from the issued invoice (€{issuedAmount.toFixed(2)}).
          Use Void &amp; reissue to send the buyer a corrected invoice.
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

function DocumentsCard({ car, setCar, setError, disabled }) {
  const fileRef = useRef(null)
  const [uploadingType, setUploadingType] = useState(null)
  const [sendingDocId, setSendingDocId] = useState(null)

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

  // Forward an uploaded document to Xero's Files Inbox where its
  // auto-bill OCR turns it into a draft Bill. The button surfaces
  // on every uploaded row; required-doc-type rows additionally
  // gate completion until at least one upload has been sent.
  async function sendToXero(docId) {
    setSendingDocId(docId); setError(null)
    try {
      const res = await fetch(`/api/cars/${car.id}/documents/${docId}/send-to-xero`, { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Send to Xero failed'); return }
      setCar(c => ({
        ...c,
        car_documents: (c.car_documents || []).map(d =>
          d.id === docId ? { ...d, ...(j.document || {}) } : d
        ),
      }))
    } finally {
      setSendingDocId(null)
    }
  }

  // "Send all unsent" — finds every uploaded doc that hasn't been
  // forwarded to Xero yet and pushes them sequentially. Useful at
  // the end of the registration process when you've uploaded
  // multiple docs in one sitting and don't want to click through
  // each row. Skips errors silently per-row (errors surface on the
  // individual rows via xero_send_error from the existing flow).
  async function sendAllUnsent() {
    setError(null)
    const unsent = (car.car_documents || []).filter(d => !d.xero_sent_at)
    for (const d of unsent) {
      // Sequential — Xero rate-limits per-org and we'd rather not
      // hammer Postmark either. Each takes <1s typically.
      await sendToXero(d.id)
    }
  }

  const unsentCount = (car.car_documents || []).filter(d => !d.xero_sent_at).length

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Documents & invoices</h3>
        {!disabled && unsentCount > 0 && (
          <button
            onClick={sendAllUnsent}
            disabled={sendingDocId !== null}
            className="text-xs inline-flex items-center gap-1 px-3 py-1 rounded-md bg-un1t-white text-un1t-black font-semibold hover:bg-un1t-accent disabled:opacity-50"
            title="Forward every uploaded document that hasn't been sent to Xero yet"
          >
            <Send size={11} /> Send all to Xero ({unsentCount})
          </button>
        )}
      </div>
      <p className="text-xs text-un1t-light mb-3">
        Required uploads must be sent to Xero (auto-billed via Xero&rsquo;s OCR) before this car can be marked completed.
      </p>
      <div className="space-y-2">
        {ALL_DOCUMENT_TYPES.map(t => {
          const docs = (car.car_documents || []).filter(d => d.doc_type === t.key)
          const required = REQUIRED_DOCUMENT_TYPES.some(r => r.key === t.key)
          const anySentToXero = docs.some(d => d.xero_sent_at)
          // Status badge: required + nothing uploaded → Required (amber);
          // required + uploaded but not sent → Send to Xero (amber);
          // required + at least one sent → Sent (green); optional rows
          // get no badge.
          let badge = null
          if (required) {
            if (!docs.length) badge = { label: 'Required', cls: 'text-amber-500' }
            else if (!anySentToXero) badge = { label: 'Send to Xero', cls: 'text-amber-500' }
            else badge = { label: 'Sent to Xero', cls: 'text-green-500' }
          }
          return (
            <div key={t.key} className="border border-un1t-gray rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium text-un1t-white">{t.label}</span>
                  {badge && (
                    <span className={`ml-2 text-[10px] uppercase ${badge.cls}`}>{badge.label}</span>
                  )}
                </div>
                <UploadOne disabled={disabled || uploadingType === t.key} loading={uploadingType === t.key} onPick={f => upload(t.key, f)} />
              </div>
              {docs.length > 0 && (
                <div className="space-y-1">
                  {docs.map(d => (
                    <div key={d.id} className="flex items-center justify-between text-xs gap-2">
                      <button onClick={() => open(d.id)} className="text-un1t-white hover:underline truncate text-left flex-1 inline-flex items-center gap-1.5 min-w-0">
                        <FileText size={12} className="shrink-0" />
                        <span className="truncate">{d.filename}</span>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        {d.xero_sent_at ? (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase text-green-500" title={`Sent ${new Date(d.xero_sent_at).toLocaleString()}`}>
                            <Check size={11} /> Sent
                          </span>
                        ) : !disabled && (
                          <button
                            onClick={() => sendToXero(d.id)}
                            disabled={sendingDocId === d.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-un1t-white text-un1t-black text-[10px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
                          >
                            <Send size={10} />
                            {sendingDocId === d.id ? 'Sending…' : 'Send to Xero'}
                          </button>
                        )}
                        {!disabled && (
                          <button onClick={() => remove(d.id)} className="text-un1t-light hover:text-red-500 p-0.5">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {docs.some(d => d.xero_send_error) && (
                <p className="mt-2 text-[11px] text-red-400">
                  Last Xero error: {docs.find(d => d.xero_send_error)?.xero_send_error}
                </p>
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
