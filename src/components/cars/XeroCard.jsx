'use client'

// Pulled out of CarDetail.jsx in May 2026 so it could be dynamic-imported
// from the parent — XeroCard only renders when the car is in pending or
// completed state, so for new-status cars (the bulk of detail page hits)
// this chunk doesn't need to be in the initial bundle.

import { Check, Receipt, RefreshCw, FileDown, AlertCircle } from 'lucide-react'

export default function XeroCard({ car, setCar, setError, busy, setBusy, disabled }) {
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
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Customer invoice (Xero)</h3>
          {issued ? (
            <div className="text-sm text-un1t-text mt-1 space-y-1">
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
                      ? <span className="text-[10px] uppercase font-semibold bg-un1t-border/40 text-un1t-subtle px-2 py-0.5 rounded-full">{car.xero_invoice_status}</span>
                      : <span className="text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">Awaiting payment</span>}
              </div>
              <div className="text-xs text-un1t-subtle flex flex-wrap gap-x-3 gap-y-1">
                {car.xero_invoice_url && (
                  <a href={car.xero_invoice_url} target="_blank" rel="noreferrer" className="hover:text-un1t-text underline inline-flex items-center gap-1">
                    Open in Xero
                  </a>
                )}
                {car.xero_invoice_pdf_path && (
                  <button onClick={viewPdf} className="hover:text-un1t-text underline inline-flex items-center gap-1">
                    <FileDown size={11} /> View PDF
                  </button>
                )}
                {car.xero_invoice_online_url && (
                  <a href={car.xero_invoice_online_url} target="_blank" rel="noreferrer" className="hover:text-un1t-text underline">Customer pay link</a>
                )}
                {car.xero_invoice_emailed_at
                  ? <span className="text-green-500">Emailed to buyer</span>
                  : <span className="text-amber-500">Not emailed</span>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-un1t-subtle mt-1 space-y-1">
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
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-un1t-text text-un1t-bg text-xs font-semibold hover:bg-un1t-accent disabled:opacity-50"
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
