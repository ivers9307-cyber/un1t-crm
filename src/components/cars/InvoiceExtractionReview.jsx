'use client'

// INVOICE-OCR.1 — review-and-push UI for a single car_document
// whose Claude Vision extraction has landed.
//
// Lives inline inside DocumentsCard.jsx — operator clicks "AI Extract"
// next to a document, the API runs, this component renders the
// editable form. Operator tweaks any field that came out wrong,
// then clicks "Push to Xero as draft". After push, shows a
// deep-link into Xero's Bills view.
//
// Edits are sent to /push-to-xero in the request body so the row's
// extracted_invoice_fields gets updated atomically with the push —
// what's stored matches what Xero received.

import { useState } from 'react'
import { Loader2, ExternalLink, RefreshCw, Send, Trash2, Plus } from 'lucide-react'

export default function InvoiceExtractionReview({
  carId,
  document,           // car_documents row, must have extracted_invoice_fields
  onChange,           // (updatedDoc) => void — called after extract / push to refresh parent
  onError,            // (msg) => void
  onClose,            // () => void — hide the review panel
}) {
  const [fields, setFields] = useState(document.extracted_invoice_fields || emptyFields())
  const [pushing, setPushing] = useState(false)
  const [reExtracting, setReExtracting] = useState(false)

  function setField(key, value) {
    setFields((f) => ({ ...f, [key]: value }))
  }

  function setLine(idx, key, value) {
    setFields((f) => ({
      ...f,
      line_items: f.line_items.map((li, i) => (i === idx ? { ...li, [key]: value } : li)),
    }))
  }

  function addLine() {
    setFields((f) => ({
      ...f,
      line_items: [
        ...f.line_items,
        { description: '', quantity: 1, unit_amount: 0, account_code: null },
      ],
    }))
  }

  function removeLine(idx) {
    setFields((f) => ({
      ...f,
      line_items: f.line_items.filter((_, i) => i !== idx),
    }))
  }

  async function reExtract() {
    setReExtracting(true)
    try {
      const res = await fetch(`/api/cars/${carId}/documents/${document.id}/extract`, { method: 'POST' })
      const j = await res.json()
      if (!j.success) {
        onError?.(j.error || 'Re-extract failed')
        return
      }
      setFields(j.fields)
      onChange?.(j.document)
    } catch (e) {
      onError?.(e.message || 'Re-extract failed')
    } finally {
      setReExtracting(false)
    }
  }

  async function pushToXero() {
    setPushing(true)
    try {
      const res = await fetch(`/api/cars/${carId}/documents/${document.id}/push-to-xero`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: normaliseForSend(fields) }),
      })
      const j = await res.json()
      if (!j.success) {
        onError?.(j.error || 'Push to Xero failed')
        return
      }
      onChange?.(j.document)
      // Open the deep-link in a new tab — operator usually wants to
      // jump into Xero to finalise.
      if (j.xero?.deep_link_url && typeof window !== 'undefined') {
        window.open(j.xero.deep_link_url, '_blank', 'noopener,noreferrer')
      }
      onClose?.()
    } catch (e) {
      onError?.(e.message || 'Push to Xero failed')
    } finally {
      setPushing(false)
    }
  }

  const subtotalDrift = Math.abs(Number(fields.total) - (Number(fields.subtotal) + Number(fields.tax_amount))) > 0.01

  return (
    <div className="mt-2 rounded-lg border border-un1t-gray bg-un1t-black p-3 text-xs space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-un1t-white">Review extracted fields</h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reExtract}
            disabled={reExtracting || pushing}
            className="inline-flex items-center gap-1 text-[10px] text-un1t-light hover:text-un1t-white disabled:opacity-50"
            title="Re-run Claude Vision against this document"
          >
            {reExtracting ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Re-extract
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={pushing}
            className="text-[10px] text-un1t-light hover:text-un1t-white disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Supplier" value={fields.supplier_name} onChange={(v) => setField('supplier_name', v)} />
        <Field label="Invoice #" value={fields.invoice_number} onChange={(v) => setField('invoice_number', v)} />
        <Field label="Invoice date" type="date" value={fields.invoice_date} onChange={(v) => setField('invoice_date', v)} />
        <Field label="Due date" type="date" value={fields.due_date || ''} onChange={(v) => setField('due_date', v || null)} />
        <Field label="Currency" value={fields.currency} onChange={(v) => setField('currency', (v || 'EUR').toUpperCase())} />
        <Field label="Supplier address" value={fields.supplier_address || ''} onChange={(v) => setField('supplier_address', v || null)} />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-un1t-light mb-1">Line items</div>
        <div className="space-y-1">
          {fields.line_items.map((li, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-1 items-center">
              <input
                className="col-span-6 bg-un1t-dark border border-un1t-gray rounded px-1.5 py-1 text-un1t-white text-[11px]"
                placeholder="Description"
                value={li.description}
                onChange={(e) => setLine(idx, 'description', e.target.value)}
              />
              <input
                type="number"
                step="0.01"
                className="col-span-2 bg-un1t-dark border border-un1t-gray rounded px-1.5 py-1 text-un1t-white text-[11px] text-right"
                placeholder="Qty"
                value={li.quantity}
                onChange={(e) => setLine(idx, 'quantity', e.target.value)}
              />
              <input
                type="number"
                step="0.01"
                className="col-span-3 bg-un1t-dark border border-un1t-gray rounded px-1.5 py-1 text-un1t-white text-[11px] text-right"
                placeholder="Unit amount"
                value={li.unit_amount}
                onChange={(e) => setLine(idx, 'unit_amount', e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeLine(idx)}
                className="col-span-1 text-un1t-light hover:text-red-500"
                title="Remove line"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addLine}
          className="mt-1 inline-flex items-center gap-1 text-[10px] text-un1t-light hover:text-un1t-white"
        >
          <Plus size={10} /> Add line
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-un1t-gray">
        <Field label="Subtotal" type="number" value={fields.subtotal} onChange={(v) => setField('subtotal', v)} align="right" />
        <Field label="Tax" type="number" value={fields.tax_amount} onChange={(v) => setField('tax_amount', v)} align="right" />
        <Field label="Total" type="number" value={fields.total} onChange={(v) => setField('total', v)} align="right" />
      </div>
      {subtotalDrift && (
        <p className="text-[10px] text-amber-400">
          Heads-up: subtotal + tax doesn&apos;t equal total. Xero will accept it but
          the bill won&apos;t balance — double-check the figures.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={pushToXero}
          disabled={pushing || reExtracting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-white text-un1t-black text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {pushing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          {pushing ? 'Pushing…' : 'Push to Xero as draft'}
          {!pushing && <ExternalLink size={11} />}
        </button>
      </div>
    </div>
  )
}

function emptyFields() {
  return {
    supplier_name: '',
    supplier_address: null,
    invoice_number: '',
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: null,
    currency: 'EUR',
    subtotal: 0,
    tax_amount: 0,
    total: 0,
    line_items: [],
  }
}

// Coerce strings → numbers before sending. The Zod schema on the
// server coerces too, but normalising here keeps the API contract
// honest in the network logs.
function normaliseForSend(f) {
  return {
    ...f,
    supplier_name: String(f.supplier_name || '').trim(),
    invoice_number: String(f.invoice_number || '').trim(),
    currency: String(f.currency || 'EUR').toUpperCase().slice(0, 3),
    subtotal: Number(f.subtotal || 0),
    tax_amount: Number(f.tax_amount || 0),
    total: Number(f.total || 0),
    line_items: (f.line_items || []).map((li) => ({
      description: String(li.description || '').trim(),
      quantity: Number(li.quantity || 0),
      unit_amount: Number(li.unit_amount || 0),
      account_code: li.account_code || null,
    })),
  }
}

function Field({ label, value, onChange, type = 'text', align }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-un1t-light">{label}</span>
      <input
        type={type}
        className={`mt-0.5 w-full bg-un1t-dark border border-un1t-gray rounded px-1.5 py-1 text-un1t-white text-[11px] ${align === 'right' ? 'text-right' : ''}`}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
