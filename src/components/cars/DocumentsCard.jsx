'use client'

// Pulled out of CarDetail.jsx in May 2026 so it could be dynamic-imported
// from the parent — DocumentsCard only renders when the car is in pending
// or completed state, so for new-status cars (the bulk of detail page
// hits) this chunk doesn't need to be in the initial bundle.
//
// CAR-DOCS-XERO-FLOW (May 2026) — removed the legacy per-row "Email"
// button + "Send all to Xero" header action + "Last Xero error" line.
// Every car-document upload now auto-enqueues into the central
// invoices_queue (INVOICES-QUEUE.1 PR 1 wires this on the upload
// route); the bookkeeper handles Claude Vision + Xero push from
// /invoices. Operators here only upload — the rest is finance work
// and shouldn't be exposed in the car-processing UI.

import { useRef, useState } from 'react'
import { Check, X, FileText, Inbox, Upload } from 'lucide-react'
import { ALL_DOCUMENT_TYPES, REQUIRED_DOCUMENT_TYPES } from '@/lib/cars'

export default function DocumentsCard({ car, setCar, setError, disabled }) {
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
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Documents & invoices</h3>
      </div>
      <p className="text-xs text-un1t-light mb-3">
        Uploads automatically enter the bookkeeper queue at <a href="/invoices" className="underline">/invoices</a>.
        The accountant reviews + pushes each one to Xero from there.
      </p>
      <div className="space-y-2">
        {ALL_DOCUMENT_TYPES.map(t => {
          const docs = (car.car_documents || []).filter(d => d.doc_type === t.key)
          const required = REQUIRED_DOCUMENT_TYPES.some(r => r.key === t.key)
          const anyPushed = docs.some(d => d.xero_bill_id)
          const hasUpload = docs.length > 0
          // CAR-DOCS-XERO-FLOW — status badges reflect the new
          // bookkeeper-queue flow:
          //   Required + nothing uploaded → 'Required' (amber)
          //   Uploaded, awaiting bookkeeper → 'Awaiting bookkeeper' (amber)
          //   Pushed to Xero (xero_bill_id set on doc) → 'In Xero' (green)
          // Optional rows show no badge until they have a Xero push.
          let badge = null
          if (required && !hasUpload) {
            badge = { label: 'Required', cls: 'text-amber-500' }
          } else if (hasUpload && !anyPushed) {
            badge = { label: 'Awaiting bookkeeper', cls: 'text-amber-500' }
          } else if (anyPushed) {
            badge = { label: 'In Xero', cls: 'text-green-500' }
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
                    <div key={d.id} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={() => open(d.id)} className="text-un1t-white hover:underline truncate text-left flex-1 inline-flex items-center gap-1.5 min-w-0">
                          <FileText size={12} className="shrink-0" />
                          <span className="truncate">{d.filename}</span>
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          {d.xero_bill_id ? (
                            // Pushed by the bookkeeper — deep link to
                            // the draft bill in Xero.
                            <a
                              href={d.xero_deep_link_url || `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${d.xero_bill_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] uppercase text-green-500 hover:underline"
                              title={`Open ${d.xero_bill_number || d.xero_bill_id} in Xero`}
                            >
                              <Check size={11} /> In Xero
                            </a>
                          ) : (
                            // Not yet pushed — surfaces a stable
                            // 'In bookkeeper queue' affordance with a
                            // link to /invoices.
                            <a
                              href="/invoices"
                              className="inline-flex items-center gap-1 text-[10px] uppercase text-un1t-light hover:text-un1t-white"
                              title="Bookkeeper handles the Xero push from /invoices"
                            >
                              <Inbox size={11} /> In queue
                            </a>
                          )}
                          {!disabled && (
                            <button onClick={() => remove(d.id)} className="text-un1t-light hover:text-red-500 p-0.5">
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
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

// Local helper — only used by DocumentsCard. Kept in the same file so
// the dynamic chunk is self-contained.
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
