// CardReceiptsManager — role-aware page body for /card-receipts (SPEND.P3).
//
// One component, two surfaces (mirrors InvoicesManager):
//   - Card holder (the `card_receipts` permission): a "New receipt"
//     submit form at the top + a list of their own submissions below.
//   - Owner / master: the review queue for their active location, with
//     Submitted / Awaiting accountant / Declined / Revoked tabs. Click
//     any row to open the detail panel with the receipt preview
//     (image or PDF in an iframe) and Approve / Decline.
//
// Same URL for everyone — the server page passes role flags and the
// list endpoint scopes itself (owner/master → active-location queue,
// everyone else → own submissions). The `?focus=<id>` query param
// (from the /approvals drill-in) auto-opens that row's detail.
//
// Submission is a 3-step flow against the live API:
//   1. POST /api/card-receipts/upload-sign → { path, token }
//   2. browser uploadToSignedUrl(path, token, file) → private bucket
//   3. POST /api/card-receipts (finalise) → 201 { data }

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw, Loader2,
  Eye, ExternalLink, Undo2, History, Upload,
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

// Owner + master are the finance approvers (same gate as the API).
const isApprover = (role) => role === 'master' || role === 'owner'

export default function CardReceiptsManager({ canSubmit = false, isApproverView = false }) {
  // The approver view (queue + history tabs) shows for owner/master;
  // submitters see their own list. A user can be both (an owner who
  // also holds a company card) — then they get the form AND the queue.
  const reviewerMode = isApproverView
  const searchParams = useSearchParams()
  const focusId = searchParams.get('focus')

  const [receipts, setReceipts] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState(reviewerMode ? 'submitted' : 'all')
  const [selectedId, setSelectedId] = useState(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/card-receipts', { cache: 'no-store' })
    const data = await res.json()
    setReceipts(data.success ? data.data || [] : [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  // ?focus=<id> auto-opens that receipt's detail once (the /approvals
  // drill-in target). Only fires on the initial value so closing the
  // modal doesn't immediately reopen it.
  useEffect(() => {
    if (focusId) setSelectedId(focusId)
  }, [focusId])

  const grouped = useMemo(() => ({
    submitted: receipts.filter((r) => r.status === 'submitted'),
    awaiting: receipts.filter((r) => r.status === 'awaiting_accountant_review'),
    declined: receipts.filter((r) => r.status === 'declined'),
    revoked: receipts.filter((r) => r.status === 'revoked'),
    all: receipts,
  }), [receipts])

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-un1t-text">Company-card receipts</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          {reviewerMode
            ? 'Review receipts for purchases made on a company card, then approve to forward to the bookkeeper or decline with a reason.'
            : canSubmit
              ? 'Photograph or upload a receipt for a purchase you made on a company card. Approved receipts ride the bookkeeper → Xero queue; declined ones come back with a note.'
              : 'This area is for company-card receipt submissions and approvals.'}
        </p>
      </header>

      {/* Neither card holder nor approver — defence-in-depth note (the
          sidebar + the page gate already hide this surface for them). */}
      {!canSubmit && !reviewerMode && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center text-sm text-un1t-subtle">
          You don&apos;t have access to company-card receipt submission or review.
          {' '}If you hold a company card, ask an owner to grant you the permission.
        </div>
      )}

      {/* Submit form — only for users who hold the card_receipts perm. */}
      {canSubmit && <SubmitForm onSubmitted={fetchList} />}

      {/* List — submitters see their own; approvers see the queue +
          history tabs. Hidden for the in-between empty case. */}
      {(canSubmit || reviewerMode) && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
          {reviewerMode ? (
            <div className="border-b border-un1t-border flex flex-wrap">
              <Tab id="submitted" label={`Awaiting review · ${grouped.submitted.length}`} active={activeTab} onClick={setActiveTab} />
              <Tab id="awaiting" label={`With accountant · ${grouped.awaiting.length}`} active={activeTab} onClick={setActiveTab} />
              <Tab id="declined" label={`Declined · ${grouped.declined.length}`} active={activeTab} onClick={setActiveTab} />
              <Tab id="revoked" label={`Revoked · ${grouped.revoked.length}`} active={activeTab} onClick={setActiveTab} />
              <Tab id="all" label={`All · ${grouped.all.length}`} active={activeTab} onClick={setActiveTab} />
            </div>
          ) : (
            <div className="border-b border-un1t-border px-4 py-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">My receipts · {receipts.length}</h2>
              <button
                onClick={fetchList}
                className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
              >
                <RefreshCw size={11} /> Refresh
              </button>
            </div>
          )}

          {loading ? (
            <div className="p-12 text-center text-un1t-subtle text-sm inline-flex items-center justify-center gap-2 w-full">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (grouped[activeTab] || []).length === 0 ? (
            <EmptyState reviewerMode={reviewerMode} tab={activeTab} />
          ) : (
            <ul className="divide-y divide-un1t-border">
              {grouped[activeTab].map((rec) => (
                <ReceiptListRow
                  key={rec.id}
                  receipt={rec}
                  reviewerMode={reviewerMode}
                  onOpen={() => setSelectedId(rec.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Detail panel */}
      {selectedId && (
        <ReceiptDetailModal
          receiptId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={fetchList}
        />
      )}
    </div>
  )
}

function Tab({ id, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${
        active === id ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      {label}
    </button>
  )
}

function EmptyState({ reviewerMode, tab }) {
  let msg = 'No receipts yet.'
  if (reviewerMode) {
    if (tab === 'submitted') msg = 'No receipts awaiting review.'
    else if (tab === 'awaiting') msg = 'No receipts with the accountant yet.'
    else if (tab === 'declined') msg = 'No declined receipts.'
    else if (tab === 'revoked') msg = 'No revoked receipts — nobody has pulled a submission back.'
    else if (tab === 'all') msg = 'No receipts at this location yet.'
  }
  return <div className="p-12 text-center text-un1t-subtle text-sm">{msg}</div>
}

// ── Submit form (card holder) ─────────────────────────────────────

function SubmitForm({ onSubmitted }) {
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [vat, setVat] = useState('')
  const [merchant, setMerchant] = useState('')
  const [cardLast4, setCardLast4] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  function reset() {
    setAmount('')
    setVat('')
    setMerchant('')
    setCardLast4('')
    setDescription('')
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
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a valid amount greater than zero.')
      return
    }
    const vatNum = vat === '' ? null : Number(vat)
    if (vatNum != null && (!Number.isFinite(vatNum) || vatNum < 0)) {
      setError('VAT must be zero or more.')
      return
    }
    if (vatNum != null && vatNum > amt) {
      setError('VAT cannot exceed the total amount.')
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

      // Step 3 — finalise.
      const finRes = await fetch('/api/card-receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchase_date: purchaseDate,
          amount: amt,
          vat_amount: vatNum,
          merchant: merchant.trim() || null,
          description: description.trim() || null,
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
        <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Submit a new receipt</h2>
        <p className="text-xs text-un1t-subtle mt-1">
          One receipt per purchase. PDF or photo, max 10 MB.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="card-receipt-date" label="Purchase date" required>
            {(props) => (
              <input
                {...props}
                type="date"
                required
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field id="card-receipt-amount" label="Amount (€)" required>
            {(props) => (
              <input
                {...props}
                type="number"
                min="0"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 42.50"
                className={inputClass}
              />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="card-receipt-vat" label="VAT (€, optional)">
            {(props) => (
              <input
                {...props}
                type="number"
                min="0"
                step="0.01"
                value={vat}
                onChange={(e) => setVat(e.target.value)}
                placeholder="e.g. 7.95"
                className={inputClass}
              />
            )}
          </Field>
          <Field id="card-receipt-merchant" label="Merchant (optional)">
            {(props) => (
              <input
                {...props}
                type="text"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="e.g. Decathlon"
                maxLength={200}
                className={inputClass}
              />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="card-receipt-last4" label="Card last-4 (optional)" hint="Last four digits of the company card used.">
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
          <Field id="card-receipt-description" label="Description (optional)">
            {(props) => (
              <input
                {...props}
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What was it for?"
                maxLength={500}
                className={inputClass}
              />
            )}
          </Field>
        </div>

        <Field id="card-receipt-notes" label="Notes (optional)">
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

        {error && (
          <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-600" /> {error}
          </div>
        )}
        {success && (
          <div className="text-xs text-emerald-700 bg-emerald-500/10 border border-emerald-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> Submitted — awaiting review.
          </div>
        )}

        <Button type="submit" loading={submitting} icon={submitting ? undefined : Upload}>
          {submitting ? 'Submitting…' : 'Submit receipt'}
        </Button>
      </form>
    </Card>
  )
}

// ── List row ──────────────────────────────────────────────────────

function ReceiptListRow({ receipt, reviewerMode, onOpen }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left px-4 py-3 hover:bg-un1t-border/20 transition-colors flex items-center gap-4"
      >
        <StatusIcon status={receipt.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-un1t-text truncate">
              {reviewerMode
                ? `${receipt.submitter?.full_name || 'Card holder'} · ${receipt.merchant || 'Company-card purchase'}`
                : (receipt.merchant || 'Company-card purchase')}
            </h3>
            <span className="text-xs text-un1t-subtle shrink-0">€{Number(receipt.amount).toFixed(2)}</span>
          </div>
          <p className="text-xs text-un1t-subtle mt-0.5">
            {reviewerMode && receipt.location?.name && (
              <>
                <span className="text-un1t-muted">{receipt.location.name}</span>
                <span className="mx-2">·</span>
              </>
            )}
            {fmtDate(receipt.purchase_date)}
            {receipt.card_last4 && (
              <>
                <span className="mx-2">·</span>
                <span className="text-un1t-muted">••{receipt.card_last4}</span>
              </>
            )}
            <span className="mx-2">·</span>
            <StatusLabel status={receipt.status} />
          </p>
        </div>
        <Eye size={14} className="text-un1t-muted shrink-0" />
      </button>
    </li>
  )
}

function StatusIcon({ status }) {
  if (status === 'awaiting_accountant_review') return <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
  if (status === 'declined') return <XCircle size={18} className="text-red-500 shrink-0" />
  if (status === 'revoked') return <Undo2 size={18} className="text-un1t-subtle shrink-0" />
  return <Clock size={18} className="text-amber-500 shrink-0" />
}

function StatusLabel({ status }) {
  if (status === 'awaiting_accountant_review') return <span className="text-emerald-700 font-medium">With accountant</span>
  if (status === 'declined') return <span className="text-red-700 font-medium">Declined</span>
  if (status === 'revoked') return <span className="text-un1t-subtle font-medium">Revoked</span>
  return <span className="text-amber-700 font-medium">Awaiting review</span>
}

// ── Detail modal ──────────────────────────────────────────────────

function ReceiptDetailModal({ receiptId, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [receiptUrl, setReceiptUrl] = useState(null)
  const [receiptMime, setReceiptMime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionState, setActionState] = useState('idle') // idle | confirming-decline | confirming-revoke | working
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const [warnings, setWarnings] = useState([])

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

  const viewerRole = data?.viewer_role
  const isApproverViewer = viewerRole === 'owner' || viewerRole === 'master'
  const isSubmitterViewer = viewerRole === 'submitter'

  async function approve() {
    setActionState('working')
    setError(null)
    setWarnings([])
    try {
      const res = await fetch(`/api/card-receipts/${receiptId}/approve`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || `Approve failed (${res.status})`)
      if (j.warnings?.length) setWarnings(j.warnings)
      onChanged?.()
      await load()
    } catch (e) {
      setError(e.message || 'Approve failed')
    } finally {
      setActionState('idle')
    }
  }

  async function decline() {
    if (!reason.trim()) {
      setError('Please enter a reason for the card holder.')
      return
    }
    setActionState('working')
    setError(null)
    try {
      const res = await fetch(`/api/card-receipts/${receiptId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || `Decline failed (${res.status})`)
      onChanged?.()
      await load()
    } catch (e) {
      setError(e.message || 'Decline failed')
    } finally {
      setActionState('idle')
    }
  }

  async function revoke() {
    setActionState('working')
    setError(null)
    try {
      const res = await fetch(`/api/card-receipts/${receiptId}/revoke`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || `Revoke failed (${res.status})`)
      onChanged?.()
      await load()
    } catch (e) {
      setError(e.message || 'Revoke failed')
    } finally {
      setActionState('idle')
    }
  }

  const isPdf = (receiptMime || '').includes('pdf')

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={data ? `${data.submitter?.full_name || 'Card holder'} · ${data.merchant || 'Company-card purchase'}` : 'Receipt'}
    >
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

          {/* Details + actions */}
          <div className="space-y-5">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Details</h4>
              <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 space-y-2 text-sm">
                <Row label="Purchase date" value={fmtDate(data.purchase_date)} />
                <Row label="Amount" value={`€${Number(data.amount).toFixed(2)}`} emphasize />
                {data.vat_amount != null && Number(data.vat_amount) > 0 && (
                  <Row label="of which VAT" value={`€${Number(data.vat_amount).toFixed(2)}`} />
                )}
                {data.merchant && <Row label="Merchant" value={data.merchant} />}
                {data.card_last4 && <Row label="Card" value={`••${data.card_last4}`} />}
                {data.location?.name && <Row label="Location" value={data.location.name} />}
                {data.description && <Row label="Description" value={data.description} />}
              </div>
            </div>

            {/* Status block */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Status</h4>
              <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 text-sm">
                <p className="inline-flex items-center gap-2">
                  <StatusIcon status={data.status} />
                  <StatusLabel status={data.status} />
                </p>
                {data.status === 'awaiting_accountant_review' && (
                  <p className="text-xs text-un1t-subtle mt-2">
                    Approved {timeAgo(data.approved_at)}
                    {data.reviewer?.full_name ? ` by ${data.reviewer.full_name}` : ''}.
                    {' '}Queued for the bookkeeper to forward to Xero.
                  </p>
                )}
                {data.status === 'declined' && data.decline_reason && (
                  <div className="mt-2 bg-amber-500/10 border-l-2 border-amber-500 p-2 text-xs text-amber-800">
                    <strong className="block mb-1">Reason:</strong>
                    {data.decline_reason}
                  </div>
                )}
                {data.status === 'revoked' && (
                  <p className="text-xs text-un1t-subtle mt-2">
                    Revoked by the card holder {timeAgo(data.revoked_at)}.
                    A fresh receipt can be submitted for the same purchase.
                  </p>
                )}
              </div>
            </div>

            <AuditTimeline data={data} />

            {data.notes && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Notes</h4>
                <p className="text-sm text-un1t-text whitespace-pre-wrap">{data.notes}</p>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-1 text-xs text-amber-800">
                {warnings.map((w, i) => (
                  <div key={i} className="inline-flex items-start gap-1.5">
                    <AlertCircle size={11} className="mt-0.5 shrink-0 text-amber-600" /> {w}
                  </div>
                ))}
              </div>
            )}
            {error && (
              <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-600" /> {error}
              </div>
            )}

            {/* Submitter self-revoke — own + submitted only. */}
            {isSubmitterViewer && data.status === 'submitted' && (
              actionState === 'confirming-revoke' ? (
                <div className="space-y-2 pt-2 border-t border-un1t-border">
                  <p className="text-xs text-un1t-subtle">
                    Revoke this submission? It stays in your history (and the approver&apos;s
                    audit trail) but leaves the review queue. You can submit a fresh receipt
                    for the same purchase afterwards.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" loading={actionState === 'working'} icon={Undo2} onClick={revoke}>
                      Yes, revoke
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setActionState('idle'); setError(null) }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="pt-2 border-t border-un1t-border">
                  <Button variant="secondary" size="sm" icon={Undo2} onClick={() => setActionState('confirming-revoke')}>
                    Revoke this submission
                  </Button>
                </div>
              )
            )}

            {/* Approver actions — owner/master + submitted only. */}
            {isApproverViewer && data.status === 'submitted' && (
              actionState === 'confirming-decline' ? (
                <div className="space-y-2 pt-2 border-t border-un1t-border">
                  <label htmlFor="card-receipt-decline-reason" className="block text-xs text-un1t-subtle">
                    Reason for decline (sent to the card holder)
                  </label>
                  <textarea
                    id="card-receipt-decline-reason"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                    maxLength={1000}
                    placeholder="e.g. This looks like a personal purchase — please confirm or re-submit the right receipt."
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  />
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" icon={XCircle} disabled={!reason.trim()} onClick={decline}>
                      Send decline
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setActionState('idle'); setReason(''); setError(null) }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 pt-2 border-t border-un1t-border">
                  <Button
                    className="flex-1 justify-center"
                    loading={actionState === 'working'}
                    icon={actionState === 'working' ? undefined : CheckCircle2}
                    onClick={approve}
                  >
                    {actionState === 'working' ? 'Approving…' : 'Approve'}
                  </Button>
                  <Button variant="danger" icon={XCircle} disabled={actionState === 'working'} onClick={() => setActionState('confirming-decline')}>
                    Decline
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function Row({ label, value, emphasize = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-un1t-subtle text-xs">{label}</span>
      <span className={emphasize ? 'text-un1t-text font-bold' : 'text-un1t-text'}>{value}</span>
    </div>
  )
}

// AuditTimeline — chronological log rebuilt from the row's stored
// timestamps (every transition has its own column), same pattern as
// the contractor-invoice detail.
function AuditTimeline({ data }) {
  const events = []
  if (data.submitted_at) {
    events.push({
      ts: data.submitted_at,
      label: 'Submitted',
      sub: data.submitter?.full_name ? `by ${data.submitter.full_name}` : null,
      tone: 'amber',
    })
  }
  if (data.revoked_at) {
    events.push({
      ts: data.revoked_at,
      label: 'Revoked by card holder',
      sub: 'Pulled back out of the review queue. A fresh receipt may have been submitted separately.',
      tone: 'neutral',
    })
  }
  if (data.declined_at) {
    events.push({
      ts: data.declined_at,
      label: 'Declined',
      sub: data.reviewer?.full_name
        ? `by ${data.reviewer.full_name}${data.decline_reason ? ` — ${data.decline_reason}` : ''}`
        : data.decline_reason || null,
      tone: 'red',
    })
  }
  if (data.approved_at) {
    events.push({
      ts: data.approved_at,
      label: 'Approved',
      sub: data.reviewer?.full_name
        ? `by ${data.reviewer.full_name} — queued for the bookkeeper`
        : 'Queued for the bookkeeper',
      tone: 'green',
    })
  }
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts))
  if (events.length === 0) return null

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 inline-flex items-center gap-1.5">
        <History size={12} /> Audit trail
      </h4>
      <ol className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 space-y-3">
        {events.map((e, i) => (
          <li key={i} className="flex gap-3">
            <TimelineDot tone={e.tone} />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-un1t-text font-medium">{e.label}</div>
              {e.sub && <div className="text-xs text-un1t-subtle mt-0.5">{e.sub}</div>}
              <div className="text-[11px] text-un1t-muted mt-0.5">
                {new Date(e.ts).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function TimelineDot({ tone }) {
  const cls =
    tone === 'green' ? 'bg-emerald-500' :
    tone === 'red' ? 'bg-red-500' :
    tone === 'amber' ? 'bg-amber-500' :
    'bg-un1t-subtle'
  return <span className={`inline-block w-2 h-2 rounded-full mt-1.5 shrink-0 ${cls}`} />
}

// ── Small formatters ──────────────────────────────────────────────

// purchase_date is a bare YYYY-MM-DD (no time, no tz). Anchor on noon
// UTC of that date so the weekday/label is stable across timezones —
// per the booking-date convention in CLAUDE.md.
function fmtDate(ymd) {
  if (!ymd) return ''
  const d = new Date(`${ymd}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return ymd
  return d.toLocaleDateString('en-IE', { dateStyle: 'medium' })
}

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// Exported for the rare caller that wants the approver predicate
// without re-deriving the role rule (mirrors InvoicesManager's
// isApprover export style). Not used by the page today.
export { isApprover }
