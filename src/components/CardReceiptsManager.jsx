// CardReceiptsManager — submitter surface for /card-receipts (SPEND.P3).
//
// Company-card receipts now ride the emailed-invoice path: the submitter
// only provides the receipt PHOTO (+ optional "which card" last-4 + note).
// The bookkeeper's OCR fills amount / merchant / date / VAT downstream in
// /invoices. There's no owner-approval step and no typed financial fields
// at submission — the receipt is auto-filed into the bookkeeper queue the
// moment it's submitted.
//
// Submission is a 3-step flow against the live API:
//   1. POST /api/card-receipts/upload-sign → { path, token }
//   2. browser uploadToSignedUrl(path, token, file) → private bucket
//   3. POST /api/card-receipts (finalise) → 201 { data }

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2, AlertCircle, RefreshCw, Loader2, Eye, ExternalLink, Upload,
} from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { Button, Modal, Card, Field } from '@/components/ui'

// The bucket name + accepted MIME list mirror the backend
// (src/lib/card-receipts.js) so the client can validate before the
// round-trip. Kept local so this component doesn't import server-only
// helpers.
const RECEIPTS_BUCKET = 'company-card-receipts'
const ACCEPTED_MIME = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]
const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*'
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export default function CardReceiptsManager() {
  const [receipts, setReceipts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/card-receipts', { cache: 'no-store' })
    const data = await res.json()
    setReceipts(data.success ? data.data || [] : [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-un1t-text">Company-card receipts</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Snap a receipt for anything you put on a company card. Accounts read the details
          off the photo and file it to Xero — you don&apos;t need to type anything in.
        </p>
      </header>

      <SubmitForm onSubmitted={fetchList} />

      <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
        <div className="border-b border-un1t-border px-4 py-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            My receipts · {receipts.length}
          </h2>
          <button
            type="button"
            onClick={fetchList}
            className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
          >
            <RefreshCw size={11} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-un1t-subtle text-sm inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : receipts.length === 0 ? (
          <div className="p-12 text-center text-un1t-subtle text-sm">
            No receipts yet. Snap your first one above.
          </div>
        ) : (
          <ul className="divide-y divide-un1t-border">
            {receipts.map((rec) => (
              <ReceiptListRow
                key={rec.id}
                receipt={rec}
                onOpen={() => setSelectedId(rec.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {selectedId && (
        <ReceiptDetailModal
          receiptId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

// ── Submit form ───────────────────────────────────────────────────

function SubmitForm({ onSubmitted }) {
  const [cardLast4, setCardLast4] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  function reset() {
    setCardLast4('')
    setNotes('')
    setFile(null)
    const fi = document.getElementById('card-receipt-file-input')
    if (fi) fi.value = ''
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (!file) {
      setError('Please attach the receipt (PDF or photo).')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('File must be 10 MB or less.')
      return
    }
    const mime = file.type || ''
    if (mime && !ACCEPTED_MIME.includes(mime)) {
      setError('Only a PDF or photo (JPG, PNG, WEBP, HEIC) is accepted.')
      return
    }
    if (cardLast4 && !/^[0-9]{4}$/.test(cardLast4)) {
      setError('Card last-4 must be exactly 4 digits.')
      return
    }

    setSubmitting(true)
    try {
      // Step 1 — sign. The mime sent to the server falls back to PDF
      // only if the browser gave us nothing (rare); the server
      // re-sniffs the real bytes anyway.
      const signRes = await fetch('/api/card-receipts/upload-sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: file.size,
          mime: mime || 'application/pdf',
          file_name: file.name,
        }),
      })
      const sign = await signRes.json()
      if (!signRes.ok || sign.success === false) {
        throw new Error(sign.error || `Could not start the upload (${signRes.status}).`)
      }

      // Step 2 — direct browser upload to the private bucket.
      const supabase = createBrowserClient()
      const { error: upErr } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .uploadToSignedUrl(sign.path, sign.token, file, { contentType: mime || 'application/pdf' })
      if (upErr) {
        throw new Error(`Upload failed: ${upErr.message}`)
      }

      // Step 3 — finalise. Auto-files into the bookkeeper queue.
      const finRes = await fetch('/api/card-receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_last4: cardLast4 || null,
          notes: notes.trim() || null,
          receipt_path: sign.path,
          receipt_name: file.name,
        }),
      })
      const fin = await finRes.json()
      if (!finRes.ok || fin.success === false) {
        throw new Error(fin.error || `Submit failed (${finRes.status}).`)
      }

      setSuccess(true)
      reset()
      onSubmitted?.()
    } catch (err) {
      setError(err.message || 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted'

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">New receipt</h2>
        <p className="text-xs text-un1t-subtle mt-1">
          Just the photo — accounts handle the rest.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="card-receipt-file-input" className="mb-1 block text-sm font-medium text-un1t-text">
            Receipt<span className="ml-0.5 text-stage-lost" aria-hidden="true">*</span>
          </label>
          <input
            id="card-receipt-file-input"
            type="file"
            accept={ACCEPT_ATTR}
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-xs text-un1t-subtle file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-un1t-border/40 file:text-un1t-text hover:file:bg-un1t-border/60"
          />
          <p className="mt-1 text-xs text-un1t-subtle">PDF or photo, max 10 MB.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="card-receipt-last4" label="Card (last 4)" hint="Last four digits of the company card used — optional.">
            {(props) => (
              <input
                {...props}
                type="text"
                inputMode="numeric"
                value={cardLast4}
                onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="1234"
                maxLength={4}
                className={inputClass}
              />
            )}
          </Field>
        </div>

        <Field id="card-receipt-notes" label="Note (optional)" hint="Anything accounts should know — what it was for, which job, etc.">
          {(props) => (
            <textarea
              {...props}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              className={inputClass}
            />
          )}
        </Field>

        {error && (
          <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-600" /> {error}
          </div>
        )}
        {success && (
          <div className="text-xs text-emerald-700 bg-emerald-500/10 border border-emerald-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> Filed with accounts ✓
          </div>
        )}

        <Button type="submit" loading={submitting} icon={submitting ? undefined : Upload}>
          {submitting ? 'Filing…' : 'File receipt'}
        </Button>
      </form>
    </Card>
  )
}

// ── List row ──────────────────────────────────────────────────────

function ReceiptListRow({ receipt, onOpen }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left px-4 py-3 hover:bg-un1t-border/20 transition-colors flex items-center gap-4"
      >
        <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-un1t-text truncate">
              {fmtDate(receipt.submitted_at)}
            </h3>
            {receipt.card_last4 && (
              <span className="text-xs text-un1t-muted shrink-0">••{receipt.card_last4}</span>
            )}
          </div>
          {receipt.notes && (
            <p className="text-xs text-un1t-subtle mt-0.5 truncate">{receipt.notes}</p>
          )}
          <p className="text-xs mt-0.5">
            <span className="text-emerald-700 font-medium">With accounts</span>
          </p>
        </div>
        <Eye size={14} className="text-un1t-muted shrink-0" />
      </button>
    </li>
  )
}

// ── Detail modal ──────────────────────────────────────────────────

function ReceiptDetailModal({ receiptId, onClose }) {
  const [data, setData] = useState(null)
  const [receiptUrl, setReceiptUrl] = useState(null)
  const [receiptMime, setReceiptMime] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [r1, r2] = await Promise.all([
      fetch(`/api/card-receipts/${receiptId}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/card-receipts/${receiptId}/receipt`, { cache: 'no-store' }).then((r) => r.json()),
    ])
    if (r1.success) setData(r1.data)
    if (r2.success) {
      setReceiptUrl(r2.url)
      setReceiptMime(r2.mime_type || null)
    }
    setLoading(false)
  }, [receiptId])

  useEffect(() => { load() }, [load])

  const isPdf = (receiptMime || '').includes('pdf')

  return (
    <Modal open onClose={onClose} size="xl" title="Receipt">
      {loading || !data ? (
        <div className="p-12 text-center text-un1t-subtle text-sm inline-flex items-center justify-center gap-2 w-full">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Receipt preview — image or PDF, both render fine in an iframe. */}
          <div className="border border-un1t-border rounded-lg bg-un1t-bg/40 min-h-[360px] flex flex-col overflow-hidden">
            <div className="p-3 border-b border-un1t-border flex items-center justify-between">
              <span className="text-xs uppercase font-semibold text-un1t-subtle">
                {isPdf ? 'Document' : 'Receipt'}
              </span>
              {receiptUrl && (
                <a
                  href={receiptUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-700 hover:text-blue-800 inline-flex items-center gap-1"
                >
                  Open in new tab <ExternalLink size={10} />
                </a>
              )}
            </div>
            {receiptUrl ? (
              <iframe
                src={receiptUrl}
                title="Receipt"
                className="flex-1 w-full bg-white min-h-[320px]"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-un1t-subtle text-xs">
                Preview unavailable
              </div>
            )}
          </div>

          {/* Details */}
          <div className="space-y-5">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Details</h4>
              <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 space-y-2 text-sm">
                <Row label="Submitted" value={fmtDate(data.submitted_at)} />
                {data.card_last4 && <Row label="Card" value={`••${data.card_last4}`} />}
                {data.location?.name && <Row label="Location" value={data.location.name} />}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Status</h4>
              <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 text-sm">
                <p className="inline-flex items-center gap-2">
                  <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                  <span className="text-emerald-700 font-medium">With accounts</span>
                </p>
                <p className="text-xs text-un1t-subtle mt-2">
                  Filed to the bookkeeper queue — they read the amount, merchant and VAT off the
                  photo and post it to Xero. Nothing else for you to do.
                </p>
              </div>
            </div>

            {data.notes && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Note</h4>
                <p className="text-sm text-un1t-text whitespace-pre-wrap">{data.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-un1t-subtle text-xs">{label}</span>
      <span className="text-un1t-text">{value}</span>
    </div>
  )
}

// ── Small formatters ──────────────────────────────────────────────

// submitted_at is a full ISO timestamp — render the medium date in
// Dublin local.
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { dateStyle: 'medium' })
}
