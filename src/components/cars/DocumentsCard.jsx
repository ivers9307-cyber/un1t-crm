'use client'

// Pulled out of CarDetail.jsx in May 2026 so it could be dynamic-imported
// from the parent — DocumentsCard only renders when the car is in pending
// or completed state, so for new-status cars (the bulk of detail page
// hits) this chunk doesn't need to be in the initial bundle.

import { useRef, useState } from 'react'
import { Check, X, FileText, Send, Upload } from 'lucide-react'
import { ALL_DOCUMENT_TYPES, REQUIRED_DOCUMENT_TYPES } from '@/lib/cars'

export default function DocumentsCard({ car, setCar, setError, disabled }) {
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
