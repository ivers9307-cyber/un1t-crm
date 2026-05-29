'use client'

// INV-BULK.2 — bulk multi-file upload for the supplier-invoice inbox.
//
// Drag-and-drop (or pick) any number of PDFs/images; they upload to the
// existing single-file POST /api/invoices-inbox in small concurrent
// batches with per-file progress, so 100 files don't burst the server
// or the browser's connection pool. Each file becomes one queue row in
// 'received'. After uploading, the operator selects rows and hits "Send
// for analysis" (INV-BULK.1 queue) — upload and analysis stay separate.

import { useState, useRef } from 'react'
import { UploadCloud, FileText, CheckCircle2, XCircle, Loader2, X } from 'lucide-react'
import { mapWithConcurrency } from '@/lib/concurrency'

const SUPPORTED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,application/pdf,image/jpeg,image/png,image/gif,image/webp'
const MAX_BYTES = 25 * 1024 * 1024
const CONCURRENCY = 4

function validate(file) {
  if (!SUPPORTED.has(file.type)) return 'Unsupported type'
  if (file.size > MAX_BYTES) return 'Over 25 MB'
  return null
}

export default function BulkUploadPanel({ locations = [], defaultLocationId = null, onUploaded }) {
  const [open, setOpen] = useState(false)
  const [locationId, setLocationId] = useState(
    defaultLocationId || (locations.length === 1 ? locations[0].id : ''),
  )
  const [items, setItems] = useState([]) // { file, status: pending|uploading|done|error|invalid, error }
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []).map((file) => {
      const err = validate(file)
      return { file, status: err ? 'invalid' : 'pending', error: err }
    })
    if (incoming.length) setItems((prev) => [...prev, ...incoming])
  }

  function setStatus(index, patch) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  async function startUpload() {
    if (!locationId || busy) return
    const targets = items
      .map((it, index) => ({ it, index }))
      .filter(({ it }) => it.status === 'pending' || it.status === 'error')
    if (targets.length === 0) return

    setBusy(true)
    await mapWithConcurrency(targets, CONCURRENCY, async ({ it, index }) => {
      setStatus(index, { status: 'uploading', error: null })
      try {
        const fd = new FormData()
        fd.append('file', it.file)
        fd.append('location_id', locationId)
        const res = await fetch('/api/invoices-inbox', { method: 'POST', body: fd })
        const j = await res.json().catch(() => ({}))
        if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
        setStatus(index, { status: 'done', error: null })
      } catch (e) {
        setStatus(index, { status: 'error', error: e.message || 'Upload failed' })
        throw e
      }
    })
    setBusy(false)
    onUploaded?.()
  }

  const counts = items.reduce((acc, it) => { acc[it.status] = (acc[it.status] || 0) + 1; return acc }, {})
  const uploadable = (counts.pending || 0) + (counts.error || 0)
  const needsLocation = !locationId

  return (
    <div className="mb-4 rounded-lg border border-un1t-border bg-un1t-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-un1t-text"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2"><UploadCloud size={16} /> Bulk upload invoices</span>
        <span className="text-xs text-un1t-subtle">{open ? 'Hide' : 'Add files'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-un1t-border pt-3">
          {locations.length > 1 && (
            <div className="mb-3">
              <label className="block text-xs text-un1t-subtle mb-1">Upload to location</label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                <option value="">Select a location…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Add invoice files"
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 cursor-pointer transition-colors ${
              dragging ? 'border-un1t-text bg-un1t-border/30' : 'border-un1t-border'
            }`}
          >
            <UploadCloud size={22} className="text-un1t-subtle" />
            <p className="text-sm text-un1t-text">Drop PDFs / images here, or click to browse</p>
            <p className="text-[11px] text-un1t-muted">PDF, JPEG, PNG, GIF, WebP · up to 25 MB each</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
            />
          </div>

          {items.length > 0 && (
            <>
              <div className="mt-3 max-h-60 overflow-y-auto divide-y divide-un1t-border/60 rounded-md border border-un1t-border">
                {items.map((it, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <FileText size={14} className="text-un1t-subtle shrink-0" />
                    <span className="flex-1 truncate text-un1t-text">{it.file.name}</span>
                    {it.status === 'uploading' && <Loader2 size={14} className="animate-spin text-un1t-subtle" />}
                    {it.status === 'done' && <CheckCircle2 size={14} className="text-emerald-500" />}
                    {(it.status === 'error' || it.status === 'invalid') && (
                      <span className="inline-flex items-center gap-1 text-xs text-stage-lost">
                        <XCircle size={13} /> {it.error}
                      </span>
                    )}
                    {it.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label={`Remove ${it.file.name}`}
                        className="text-un1t-muted hover:text-un1t-text"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-un1t-subtle">
                  {counts.done ? `${counts.done} uploaded` : ''}
                  {counts.error ? ` · ${counts.error} failed` : ''}
                  {counts.invalid ? ` · ${counts.invalid} skipped` : ''}
                  {uploadable ? `${counts.done || counts.error ? ' · ' : ''}${uploadable} ready` : ''}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setItems([])}
                    disabled={busy}
                    className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={startUpload}
                    disabled={busy || uploadable === 0 || needsLocation}
                    title={needsLocation ? 'Pick a location first' : undefined}
                    className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                    {busy ? 'Uploading…' : `Upload ${uploadable}`}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
