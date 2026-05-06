// InvoicesManager — role-aware page body for /schedule/invoices.
//
// One component, two surfaces:
//   - Contractor (any non-owner/master role): submit form at the
//     top, list of their own past submissions below.
//   - Owner / master: review queue at the top (Submitted), then
//     historical Approved + Declined tabs. Click any row to open
//     the review panel with PDF preview, scheduled hours,
//     estimated cost vs invoiced amount, and Approve/Decline.
//
// We intentionally don't have two routes — same URL, the user just
// sees what's relevant to them. Avoids the "where do I go?"
// question for masters who are also contractors.

'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Upload, FileText, CheckCircle2, XCircle, Clock, AlertCircle,
  RefreshCw, Loader2, Eye, ExternalLink,
} from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { recentMonthOptions, defaultMonthKey, periodLabel } from '@/lib/contractor-invoices'

const isMgr = (role) => MANAGER_ROLES.includes(role) || role === 'master'

export default function InvoicesManager({ user }) {
  const reviewerMode = isMgr(user.role)
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState(reviewerMode ? 'submitted' : 'all')
  const [selectedId, setSelectedId] = useState(null)

  async function fetchList() {
    setLoading(true)
    const res = await fetch('/api/invoices', { cache: 'no-store' })
    const data = await res.json()
    setInvoices(data.success ? data.data || [] : [])
    setLoading(false)
  }

  useEffect(() => { fetchList() }, [])

  const grouped = useMemo(() => ({
    submitted: invoices.filter(i => i.status === 'submitted'),
    approved: invoices.filter(i => i.status === 'approved'),
    declined: invoices.filter(i => i.status === 'declined'),
    all: invoices,
  }), [invoices])

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-un1t-white">Contractor invoices</h1>
        <p className="text-sm text-un1t-light mt-1">
          {reviewerMode
            ? 'Review submitted invoices against scheduled hours, then approve to forward to Xero or decline with a reason.'
            : 'Submit your monthly invoice as a PDF. Approved invoices are forwarded to accounts; declined ones come back with notes for adjustment.'}
        </p>
      </header>

      {/* Contractor: submit form on top */}
      {!reviewerMode && (
        <SubmitForm user={user} onSubmitted={fetchList} />
      )}

      {/* List view */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
        {/* Tabs */}
        {reviewerMode ? (
          <div className="border-b border-un1t-gray flex">
            <Tab id="submitted" label={`Awaiting review · ${grouped.submitted.length}`} active={activeTab} onClick={setActiveTab} />
            <Tab id="approved" label={`Approved · ${grouped.approved.length}`} active={activeTab} onClick={setActiveTab} />
            <Tab id="declined" label={`Declined · ${grouped.declined.length}`} active={activeTab} onClick={setActiveTab} />
          </div>
        ) : (
          <div className="border-b border-un1t-gray px-4 py-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">My submissions · {invoices.length}</h2>
            <button
              onClick={fetchList}
              className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
            >
              <RefreshCw size={11} /> Refresh
            </button>
          </div>
        )}

        {loading ? (
          <div className="p-12 text-center text-un1t-light text-sm inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (grouped[activeTab] || []).length === 0 ? (
          <EmptyState reviewerMode={reviewerMode} tab={activeTab} />
        ) : (
          <ul className="divide-y divide-un1t-gray">
            {grouped[activeTab].map(inv => (
              <InvoiceListRow
                key={inv.id}
                invoice={inv}
                reviewerMode={reviewerMode}
                onOpen={() => setSelectedId(inv.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Review panel */}
      {selectedId && (
        <InvoiceDetailModal
          invoiceId={selectedId}
          reviewerMode={reviewerMode}
          onClose={() => setSelectedId(null)}
          onChanged={() => { fetchList(); }}
        />
      )}
    </div>
  )
}

function Tab({ id, label, active, onClick }) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${
        active === id ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'
      }`}
    >
      {label}
    </button>
  )
}

function EmptyState({ reviewerMode, tab }) {
  let msg = 'No invoices yet.'
  if (reviewerMode) {
    if (tab === 'submitted') msg = 'No invoices awaiting review.'
    else if (tab === 'approved') msg = 'No approved invoices yet.'
    else if (tab === 'declined') msg = 'No declined invoices.'
  }
  return (
    <div className="p-12 text-center text-un1t-light text-sm">{msg}</div>
  )
}

// ── Submit form (contractor) ──────────────────────────────────────

function SubmitForm({ user, onSubmitted }) {
  const months = useMemo(() => recentMonthOptions(new Date(), 6), [])
  const [month, setMonth] = useState(defaultMonthKey())
  const [amount, setAmount] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [pdf, setPdf] = useState(null)
  const [locationId, setLocationId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  const myLocations = (user.profile_locations || user.assignments || []).map((a) => ({
    id: a.location_id,
    name: a.locations?.name || a.location_name || a.location_id,
  }))
  // Fallback if user payload doesn't carry locations: show a single
  // disabled note. Most contractors will have at least one location.
  const needsLocationPicker = myLocations.length > 1
  const defaultLocationId = myLocations.length === 1 ? myLocations[0].id : ''

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (!pdf) {
      setError('Please attach the PDF.')
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.set('month', month)
      fd.set('amount', amount)
      if (invoiceNumber) fd.set('invoice_number', invoiceNumber)
      if (notes) fd.set('notes', notes)
      const useLoc = needsLocationPicker ? locationId : defaultLocationId
      if (useLoc) fd.set('location_id', useLoc)
      fd.set('pdf', pdf)

      const res = await fetch('/api/invoices', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || `Submit failed (${res.status})`)
      setSuccess(true)
      setAmount('')
      setInvoiceNumber('')
      setNotes('')
      setPdf(null)
      // Reset file input
      const fi = document.getElementById('invoice-pdf-input')
      if (fi) fi.value = ''
      onSubmitted?.()
    } catch (err) {
      setError(err.message || 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Submit a new invoice</h2>
        <p className="text-xs text-un1t-light mt-1">
          One invoice per calendar month. PDF only, max 10 MB.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-un1t-light mb-1">Period *</label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          >
            {months.map(m => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-un1t-light mb-1">Amount (€) *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 1250.00"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          />
        </div>
      </div>

      {needsLocationPicker && (
        <div>
          <label className="block text-xs text-un1t-light mb-1">Studio *</label>
          <select
            required
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          >
            <option value="">Choose…</option>
            {myLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs text-un1t-light mb-1">Your invoice reference (optional)</label>
        <input
          type="text"
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
          placeholder="e.g. INV-2026-04"
          maxLength={50}
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
        />
      </div>

      <div>
        <label className="block text-xs text-un1t-light mb-1">Notes (optional)</label>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
        />
      </div>

      <div>
        <label className="block text-xs text-un1t-light mb-1">PDF *</label>
        <input
          id="invoice-pdf-input"
          type="file"
          accept="application/pdf"
          required
          onChange={(e) => setPdf(e.target.files?.[0] || null)}
          className="block w-full text-xs text-un1t-light file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-un1t-gray/40 file:text-un1t-white hover:file:bg-un1t-gray/60"
        />
      </div>

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="text-xs text-green-300 bg-green-500/10 border border-green-500/30 rounded p-2 inline-flex items-start gap-1.5">
          <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> Submitted — awaiting review.
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="bg-un1t-white text-un1t-black font-medium text-sm px-4 py-2 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        {submitting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        {submitting ? 'Submitting…' : 'Submit invoice'}
      </button>
    </form>
  )
}

// ── List row ──────────────────────────────────────────────────────

function InvoiceListRow({ invoice, reviewerMode, onOpen }) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full text-left px-4 py-3 hover:bg-un1t-gray/20 transition-colors flex items-center gap-4"
      >
        <StatusIcon status={invoice.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-un1t-white truncate">
              {reviewerMode
                ? `${invoice.contractor?.full_name || 'Contractor'} · ${periodLabel(invoice.period_start)}`
                : periodLabel(invoice.period_start)}
            </h3>
            <span className="text-xs text-un1t-light shrink-0">€{Number(invoice.invoice_amount).toFixed(2)}</span>
          </div>
          <p className="text-xs text-un1t-light mt-0.5">
            {reviewerMode && (
              <>
                <span className="text-un1t-mid">{invoice.location?.name || 'No location'}</span>
                <span className="mx-2">·</span>
              </>
            )}
            <StatusLabel status={invoice.status} />
            <span className="mx-2">·</span>
            Submitted {timeAgo(invoice.submitted_at)}
            {invoice.status === 'approved' && invoice.xero_synced_at && (
              <>
                <span className="mx-2">·</span>
                <span className="text-green-300">Synced to Xero</span>
              </>
            )}
          </p>
        </div>
        <Eye size={14} className="text-un1t-mid shrink-0" />
      </button>
    </li>
  )
}

function StatusIcon({ status }) {
  if (status === 'approved') return <CheckCircle2 size={18} className="text-green-400 shrink-0" />
  if (status === 'declined') return <XCircle size={18} className="text-red-400 shrink-0" />
  return <Clock size={18} className="text-amber-400 shrink-0" />
}
function StatusLabel({ status }) {
  if (status === 'approved') return <span className="text-green-300 font-medium">Approved</span>
  if (status === 'declined') return <span className="text-red-300 font-medium">Declined</span>
  return <span className="text-amber-300 font-medium">Awaiting review</span>
}

// ── Detail modal ──────────────────────────────────────────────────

function InvoiceDetailModal({ invoiceId, reviewerMode, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionState, setActionState] = useState('idle') // idle | confirming-decline | working
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)
  const [warnings, setWarnings] = useState([])

  async function load() {
    setLoading(true)
    const [r1, r2] = await Promise.all([
      fetch(`/api/invoices/${invoiceId}`, { cache: 'no-store' }).then(r => r.json()),
      fetch(`/api/invoices/${invoiceId}/pdf`, { cache: 'no-store' }).then(r => r.json()),
    ])
    if (r1.success) setData(r1.data)
    if (r2.success) setPdfUrl(r2.url)
    setLoading(false)
  }
  useEffect(() => { load() }, [invoiceId])

  async function approve() {
    setActionState('working')
    setError(null)
    setWarnings([])
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/approve`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || `Approve failed (${res.status})`)
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
      setError('Please enter a reason for the contractor.')
      return
    }
    setActionState('working')
    setError(null)
    setWarnings([])
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || `Decline failed (${res.status})`)
      if (j.warnings?.length) setWarnings(j.warnings)
      onChanged?.()
      await load()
    } catch (e) {
      setError(e.message || 'Decline failed')
    } finally {
      setActionState('idle')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-un1t-dark border border-un1t-gray rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {loading || !data ? (
          <div className="p-12 text-center text-un1t-light text-sm inline-flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-un1t-gray">
              <div className="min-w-0">
                <h3 className="font-semibold text-un1t-white">
                  {data.contractor?.full_name || 'Contractor'} · {periodLabel(data.period_start)}
                </h3>
                <p className="text-xs text-un1t-light mt-1">
                  {data.location?.name} · €{Number(data.invoice_amount).toFixed(2)}
                  {data.invoice_number && <span className="ml-2 text-un1t-mid">Ref {data.invoice_number}</span>}
                </p>
              </div>
              <button onClick={onClose} className="text-un1t-light hover:text-un1t-white shrink-0">
                <XCircle size={18} />
              </button>
            </div>

            {/* Body — split: PDF on left (or nothing if mobile), details on right */}
            <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-0">
              <div className="border-r border-un1t-gray bg-un1t-black/40 min-h-[400px] flex flex-col">
                <div className="p-3 border-b border-un1t-gray flex items-center justify-between">
                  <span className="text-xs uppercase font-semibold text-un1t-light">PDF</span>
                  {pdfUrl && (
                    <a
                      href={pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                    >
                      Open in new tab <ExternalLink size={10} />
                    </a>
                  )}
                </div>
                {pdfUrl ? (
                  <iframe
                    src={pdfUrl}
                    title="Invoice PDF"
                    className="flex-1 w-full bg-white"
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-un1t-light text-xs">
                    PDF preview unavailable
                  </div>
                )}
              </div>

              <div className="p-5 space-y-5">
                {/* Computed comparison */}
                {data.computed_scheduled && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">
                      Schedule vs invoice
                    </h4>
                    <div className="bg-un1t-black/60 border border-un1t-gray rounded-lg p-4 space-y-2 text-sm">
                      <Row label="Scheduled hours" value={`${data.computed_scheduled.scheduled_hours} h`} sub={`${data.computed_scheduled.shift_count} shifts`} />
                      <Row
                        label="Hourly rate"
                        value={data.computed_scheduled.hourly_rate
                          ? `€${data.computed_scheduled.hourly_rate.toFixed(2)}/h`
                          : <span className="text-amber-300">Not set on profile</span>}
                      />
                      <Row
                        label="Estimated cost"
                        value={data.computed_scheduled.estimated_cost != null
                          ? `€${data.computed_scheduled.estimated_cost.toFixed(2)}`
                          : '—'}
                        emphasize
                      />
                      <div className="pt-2 mt-2 border-t border-un1t-gray">
                        <Row
                          label="Invoiced amount"
                          value={`€${Number(data.invoice_amount).toFixed(2)}`}
                          emphasize
                        />
                        <DiffRow
                          invoiced={Number(data.invoice_amount)}
                          estimated={data.computed_scheduled.estimated_cost}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Status block */}
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Status</h4>
                  <div className="bg-un1t-black/60 border border-un1t-gray rounded-lg p-4 text-sm">
                    <p className="inline-flex items-center gap-2">
                      <StatusIcon status={data.status} />
                      <StatusLabel status={data.status} />
                    </p>
                    {data.status === 'approved' && (
                      <p className="text-xs text-un1t-light mt-2">
                        Approved {timeAgo(data.approved_at)}
                        {data.reviewer?.full_name ? ` by ${data.reviewer.full_name}` : ''}.
                        {data.xero_synced_at
                          ? ' Forwarded to Xero.'
                          : ' Xero forward pending — retry from a refresh of this page.'}
                      </p>
                    )}
                    {data.status === 'declined' && data.decline_reason && (
                      <div className="mt-2 bg-amber-500/10 border-l-2 border-amber-500 p-2 text-xs text-amber-200">
                        <strong className="block mb-1">Reason:</strong>
                        {data.decline_reason}
                      </div>
                    )}
                  </div>
                </div>

                {data.notes && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">Contractor notes</h4>
                    <p className="text-sm text-un1t-white whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}

                {warnings.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-1 text-xs text-amber-200">
                    {warnings.map((w, i) => <div key={i} className="inline-flex items-start gap-1.5"><AlertCircle size={11} className="mt-0.5 shrink-0" /> {w}</div>)}
                  </div>
                )}
                {error && (
                  <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
                  </div>
                )}

                {/* Action footer — owner/master + submitted only */}
                {reviewerMode && data.status === 'submitted' && (
                  actionState === 'confirming-decline' ? (
                    <div className="space-y-2 pt-2 border-t border-un1t-gray">
                      <label className="block text-xs text-un1t-light">Reason for decline (sent to contractor)</label>
                      <textarea
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        autoFocus
                        maxLength={1000}
                        placeholder="e.g. Hours don't match scheduled shifts — please re-issue with corrected total."
                        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={decline}
                          disabled={!reason.trim()}
                          className="bg-red-500 hover:bg-red-600 text-white text-xs font-semibold px-3 py-2 rounded-md disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          <XCircle size={12} /> Send decline
                        </button>
                        <button
                          onClick={() => { setActionState('idle'); setReason(''); setError(null) }}
                          className="text-xs text-un1t-light hover:text-un1t-white px-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 pt-2 border-t border-un1t-gray">
                      <button
                        onClick={approve}
                        disabled={actionState === 'working'}
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2.5 rounded-md inline-flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {actionState === 'working' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                        {actionState === 'working' ? 'Approving…' : 'Approve & forward to Xero'}
                      </button>
                      <button
                        onClick={() => setActionState('confirming-decline')}
                        disabled={actionState === 'working'}
                        className="bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 text-sm font-semibold px-4 py-2.5 rounded-md inline-flex items-center gap-1.5"
                      >
                        <XCircle size={14} /> Decline
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, sub, emphasize = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-un1t-light text-xs">{label}</span>
      <span className={emphasize ? 'text-un1t-white font-bold' : 'text-un1t-white'}>
        {value}
        {sub && <span className="text-un1t-mid text-[11px] ml-2">({sub})</span>}
      </span>
    </div>
  )
}
function DiffRow({ invoiced, estimated }) {
  if (estimated == null || !Number.isFinite(estimated)) return null
  const diff = invoiced - estimated
  const pct = estimated > 0 ? (diff / estimated) * 100 : 0
  if (Math.abs(diff) < 0.005) {
    return <p className="text-xs text-green-300 mt-1.5 inline-flex items-center gap-1"><CheckCircle2 size={11} /> Invoiced amount matches estimate.</p>
  }
  const sign = diff > 0 ? '+' : ''
  return (
    <p className={`text-xs mt-1.5 inline-flex items-center gap-1 ${Math.abs(pct) > 5 ? 'text-amber-300' : 'text-un1t-light'}`}>
      <AlertCircle size={11} />
      Invoiced {sign}€{diff.toFixed(2)} vs estimate ({sign}{pct.toFixed(1)}%)
    </p>
  )
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
