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
  Upload, CheckCircle2, XCircle, Clock, AlertCircle,
  RefreshCw, Loader2, Eye, ExternalLink, Undo2, History,
} from 'lucide-react'
import { recentMonthOptions, defaultMonthKey, periodLabel } from '@/lib/contractor-invoices'

// Approver = the only roles allowed to review + approve/decline.
// Tighter than MANAGER_ROLES (which includes manager + head_coach):
// we want the financial-sign-off to live with master + owner only.
const isApprover = (role) => role === 'master' || role === 'owner'

// Contractor = the only employment_type allowed to submit invoices.
// Hide the upload form from FTEs and any other employment shape.
const isContractor = (user) => user?.employment_type === 'contractor'

export default function InvoicesManager({ user }) {
  const reviewerMode = isApprover(user.role)
  const canSubmit = isContractor(user)
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
    // INVOICES-QUEUE.1 — the "Approved" tab now includes both the
    // legacy 'approved' state (in-flight items at the old direct-
    // to-Xero path) AND the new 'awaiting_accountant_review' state
    // (owner approved, queued for accountant). Both represent
    // "owner has approved this" from the operator's POV — the
    // distinction matters to the bookkeeper, not to the
    // contractor or approver browsing this list.
    approved: invoices.filter(i => i.status === 'approved' || i.status === 'awaiting_accountant_review'),
    declined: invoices.filter(i => i.status === 'declined'),
    revoked: invoices.filter(i => i.status === 'revoked'),
    all: invoices,
  }), [invoices])

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-un1t-text">Contractor invoices</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          {reviewerMode
            ? 'Review submitted invoices against scheduled hours, then approve to forward to Xero or decline with a reason.'
            : canSubmit
              ? 'Submit your monthly invoice as a PDF. Approved invoices are forwarded to accounts; declined ones come back with notes for adjustment.'
              : 'This area is for contractor invoice submissions and approvals.'}
        </p>
      </header>

      {/* Neither contractor nor approver — show a friendly note and nothing else.
          ScheduleTabs hides the tab entirely for these users, so this is a
          defence-in-depth path (direct URL, role flip, etc.). */}
      {!canSubmit && !reviewerMode && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center text-sm text-un1t-subtle">
          You don&apos;t have access to invoice submission or review.
          {' '}If you should be set up as a contractor, ask an owner to update your profile.
        </div>
      )}

      {/* Submit form — only visible to staff with employment_type =
          'contractor'. FTEs and admin roles never invoice this way,
          so the form would just be confusing noise for them. */}
      {canSubmit && <SubmitForm user={user} onSubmitted={fetchList} />}

      {/* List view — contractors see their own submissions; approvers
          see the review queue + history tabs. Hidden for the in-between
          empty case. */}
      {(canSubmit || reviewerMode) && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
        {/* Tabs */}
        {reviewerMode ? (
          <div className="border-b border-un1t-border flex flex-wrap">
            <Tab id="submitted" label={`Awaiting review · ${grouped.submitted.length}`} active={activeTab} onClick={setActiveTab} />
            <Tab id="approved" label={`Approved · ${grouped.approved.length}`} active={activeTab} onClick={setActiveTab} />
            <Tab id="declined" label={`Declined · ${grouped.declined.length}`} active={activeTab} onClick={setActiveTab} />
            <Tab id="revoked" label={`Revoked · ${grouped.revoked.length}`} active={activeTab} onClick={setActiveTab} />
          </div>
        ) : (
          <div className="border-b border-un1t-border px-4 py-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">My submissions · {invoices.length}</h2>
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
      )}

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
        active === id ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
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
    else if (tab === 'revoked') msg = 'No revoked invoices — contractors haven\'t pulled any submissions back.'
  }
  return (
    <div className="p-12 text-center text-un1t-subtle text-sm">{msg}</div>
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  // The submission is always tied to the location the user has
  // ACTIVE in the sidebar location switcher. If they want to
  // invoice a different studio, they switch up there first. This
  // matches how every other surface in the app scopes itself
  // (Schedule, Orders, etc. all key off activeLocation).
  const activeLocation = user.activeLocation || null

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (!pdf) {
      setError('Please attach the PDF.')
      return
    }
    if (!activeLocation?.id) {
      setError('No active location — pick a studio in the sidebar before submitting.')
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.set('month', month)
      fd.set('amount', amount)
      if (invoiceNumber) fd.set('invoice_number', invoiceNumber)
      if (notes) fd.set('notes', notes)
      fd.set('location_id', activeLocation.id)
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
    <form onSubmit={handleSubmit} className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Submit a new invoice</h2>
        <p className="text-xs text-un1t-subtle mt-1">
          One invoice per calendar month. PDF only, max 10 MB.
          {activeLocation?.name && (
            <>
              {' '}Submitting for <span className="text-un1t-text font-medium">{activeLocation.name}</span>
              {' '}— switch studios in the sidebar to change.
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-un1t-subtle mb-1">Period *</label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
          >
            {months.map(m => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-un1t-subtle mb-1">Amount (€) *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 1250.00"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-un1t-subtle mb-1">Your invoice reference (optional)</label>
        <input
          type="text"
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
          placeholder="e.g. INV-2026-04"
          maxLength={50}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
        />
      </div>

      <div>
        <label className="block text-xs text-un1t-subtle mb-1">Notes (optional)</label>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
        />
      </div>

      <div>
        <label className="block text-xs text-un1t-subtle mb-1">PDF *</label>
        <input
          id="invoice-pdf-input"
          type="file"
          accept="application/pdf"
          required
          onChange={(e) => setPdf(e.target.files?.[0] || null)}
          className="block w-full text-xs text-un1t-subtle file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-un1t-border/40 file:text-un1t-text hover:file:bg-un1t-border/60"
        />
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded p-2 inline-flex items-start gap-1.5">
          <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> Submitted — awaiting review.
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="bg-un1t-text text-un1t-bg font-medium text-sm px-4 py-2 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
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
        className="w-full text-left px-4 py-3 hover:bg-un1t-border/20 transition-colors flex items-center gap-4"
      >
        <StatusIcon status={invoice.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-un1t-text truncate">
              {reviewerMode
                ? `${invoice.contractor?.full_name || 'Contractor'} · ${periodLabel(invoice.period_start)}`
                : periodLabel(invoice.period_start)}
            </h3>
            <span className="text-xs text-un1t-subtle shrink-0">€{Number(invoice.invoice_amount).toFixed(2)}</span>
          </div>
          <p className="text-xs text-un1t-subtle mt-0.5">
            {reviewerMode && (
              <>
                <span className="text-un1t-muted">{invoice.location?.name || 'No location'}</span>
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
        <Eye size={14} className="text-un1t-muted shrink-0" />
      </button>
    </li>
  )
}

function StatusIcon({ status }) {
  // INVOICES-QUEUE.1 — awaiting_accountant_review uses the same
  // green tick as approved (both happy-path post-owner-approval).
  if (status === 'approved' || status === 'awaiting_accountant_review') return <CheckCircle2 size={18} className="text-green-400 shrink-0" />
  if (status === 'declined') return <XCircle size={18} className="text-red-400 shrink-0" />
  if (status === 'revoked') return <Undo2 size={18} className="text-un1t-subtle shrink-0" />
  return <Clock size={18} className="text-amber-400 shrink-0" />
}
function StatusLabel({ status }) {
  if (status === 'approved') return <span className="text-green-300 font-medium">Approved</span>
  // Different short label so the contractor can see WHERE their
  // invoice sits even though it's already been signed off by the
  // owner.
  if (status === 'awaiting_accountant_review') return <span className="text-green-300 font-medium">With accountant</span>
  if (status === 'declined') return <span className="text-red-300 font-medium">Declined</span>
  if (status === 'revoked') return <span className="text-un1t-subtle font-medium">Revoked by contractor</span>
  return <span className="text-amber-300 font-medium">Awaiting review</span>
}

// ── Detail modal ──────────────────────────────────────────────────

function InvoiceDetailModal({ invoiceId, reviewerMode, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionState, setActionState] = useState('idle') // idle | confirming-decline | confirming-revoke | working
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
  // `load` is defined in this component; we only want to re-fetch when
  // the invoiceId changes, not on every render. Excluding load from
  // the deps avoids the refire-loop the auto-fix would create.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function revoke() {
    setActionState('working')
    setError(null)
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/revoke`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || `Revoke failed (${res.status})`)
      onChanged?.()
      await load()
    } catch (e) {
      setError(e.message || 'Revoke failed')
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
        className="bg-un1t-surface border border-un1t-border rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {loading || !data ? (
          <div className="p-12 text-center text-un1t-subtle text-sm inline-flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-un1t-border">
              <div className="min-w-0">
                <h3 className="font-semibold text-un1t-text">
                  {data.contractor?.full_name || 'Contractor'} · {periodLabel(data.period_start)}
                </h3>
                <p className="text-xs text-un1t-subtle mt-1">
                  {data.location?.name} · €{Number(data.invoice_amount).toFixed(2)}
                  {data.invoice_number && <span className="ml-2 text-un1t-muted">Ref {data.invoice_number}</span>}
                </p>
              </div>
              <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text shrink-0">
                <XCircle size={18} />
              </button>
            </div>

            {/* Body — split: PDF on left (or nothing if mobile), details on right */}
            <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-0">
              <div className="border-r border-un1t-border bg-un1t-bg/40 min-h-[400px] flex flex-col">
                <div className="p-3 border-b border-un1t-border flex items-center justify-between">
                  <span className="text-xs uppercase font-semibold text-un1t-subtle">Document</span>
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
                    title="Invoice attachment"
                    className="flex-1 w-full bg-white"
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-un1t-subtle text-xs">
                    Preview unavailable
                  </div>
                )}
              </div>

              <div className="p-5 space-y-5">
                {/* Computed comparison — REVIEWER ONLY.
                    Schedule-vs-invoice exposes the company's
                    estimated cost (rate × hours), which is
                    commercially sensitive and not for the
                    contractor's eyes. The API also strips this
                    block for self-views as a defence-in-depth. */}
                {reviewerMode && data.computed_scheduled && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
                      Schedule vs invoice
                    </h4>
                    <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 space-y-2 text-sm">
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
                      <div className="pt-2 mt-2 border-t border-un1t-border">
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
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Status</h4>
                  <div className="bg-un1t-bg/60 border border-un1t-border rounded-lg p-4 text-sm">
                    <p className="inline-flex items-center gap-2">
                      <StatusIcon status={data.status} />
                      <StatusLabel status={data.status} />
                    </p>
                    {data.status === 'approved' && (
                      <p className="text-xs text-un1t-subtle mt-2">
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
                    {data.status === 'revoked' && (
                      <p className="text-xs text-un1t-subtle mt-2">
                        Revoked by the contractor {timeAgo(data.revoked_at)}.
                        A fresh submission can be made for the same period.
                      </p>
                    )}
                  </div>
                </div>

                {/* Audit timeline — visible to everyone, useful both
                    for the contractor (so they remember what they did)
                    and for the approver (so the history is on-screen
                    next to the current state). */}
                <AuditTimeline data={data} />

                {data.notes && (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Contractor notes</h4>
                    <p className="text-sm text-un1t-text whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}

                {warnings.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-1 text-xs text-amber-200">
                    {warnings.map((w, i) => <div key={i} className="inline-flex items-start gap-1.5"><AlertCircle size={11} className="mt-0.5 shrink-0" /> {w}</div>)}
                  </div>
                )}
                {error && (
                  <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
                  </div>
                )}

                {/* Contractor self-revoke — only the owner of the
                    invoice while it's still pending review. */}
                {!reviewerMode && data.status === 'submitted' && data.viewer_role === 'self' && (
                  actionState === 'confirming-revoke' ? (
                    <div className="space-y-2 pt-2 border-t border-un1t-border">
                      <p className="text-xs text-un1t-subtle">
                        Revoke this submission? It stays in your history (and the approver's audit
                        trail) but is no longer in the review queue. You can submit a fresh invoice
                        for the same month afterwards.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={revoke}
                          disabled={actionState === 'working'}
                          className="bg-un1t-subtle text-un1t-bg hover:bg-un1t-text text-xs font-semibold px-3 py-2 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {actionState === 'working' ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                          Yes, revoke
                        </button>
                        <button
                          onClick={() => { setActionState('idle'); setError(null) }}
                          className="text-xs text-un1t-subtle hover:text-un1t-text px-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="pt-2 border-t border-un1t-border">
                      <button
                        onClick={() => setActionState('confirming-revoke')}
                        className="text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-muted px-3 py-2 rounded-md inline-flex items-center gap-1.5"
                        title="Pull this submission back so you can resubmit"
                      >
                        <Undo2 size={11} /> Revoke this submission
                      </button>
                    </div>
                  )
                )}

                {/* Action footer — owner/master + submitted only */}
                {reviewerMode && data.status === 'submitted' && (
                  actionState === 'confirming-decline' ? (
                    <div className="space-y-2 pt-2 border-t border-un1t-border">
                      <label className="block text-xs text-un1t-subtle">Reason for decline (sent to contractor)</label>
                      <textarea
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        autoFocus
                        maxLength={1000}
                        placeholder="e.g. Hours don't match scheduled shifts — please re-issue with corrected total."
                        className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
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
                          className="text-xs text-un1t-subtle hover:text-un1t-text px-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 pt-2 border-t border-un1t-border">
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
                        className="bg-red-500/15 text-red-700 border border-red-500/30 hover:bg-red-500/25 text-sm font-semibold px-4 py-2.5 rounded-md inline-flex items-center gap-1.5"
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
      <span className="text-un1t-subtle text-xs">{label}</span>
      <span className={emphasize ? 'text-un1t-text font-bold' : 'text-un1t-text'}>
        {value}
        {sub && <span className="text-un1t-muted text-[11px] ml-2">({sub})</span>}
      </span>
    </div>
  )
}
function DiffRow({ invoiced, estimated }) {
  if (estimated == null || !Number.isFinite(estimated)) return null
  const diff = invoiced - estimated
  const pct = estimated > 0 ? (diff / estimated) * 100 : 0

  // Match: solid green pill, white text — works on any theme.
  if (Math.abs(diff) < 0.005) {
    return (
      <div className="mt-3 rounded-md bg-green-600 text-white px-4 py-3 flex items-center gap-2.5 shadow">
        <CheckCircle2 size={18} className="shrink-0" />
        <span className="text-base font-semibold">Invoiced amount matches estimate</span>
      </div>
    )
  }

  // Mismatch: solid orange (>5% off) or neutral (small drift) box,
  // white text. We use solid background colors instead of low-alpha
  // tints so the callout stays high-contrast regardless of light or
  // dark page theme — the previous amber-on-amber washed out on
  // light backgrounds.
  const isBig = Math.abs(pct) > 5
  const bgClass = isBig
    ? 'bg-orange-600 text-white'
    : 'bg-slate-700 text-white'
  return (
    <div className={`mt-3 rounded-md ${bgClass} px-4 py-3 flex items-start gap-3 shadow`}>
      <AlertCircle size={20} className="shrink-0 mt-0.5" />
      <div className="leading-snug">
        <div className="text-base font-bold">
          Invoiced €{Math.abs(diff).toFixed(2)} {diff > 0 ? 'over' : 'under'} estimate
        </div>
        <div className="text-sm font-medium opacity-90 mt-0.5">
          {diff > 0 ? '+' : '−'}{Math.abs(pct).toFixed(1)}% vs scheduled hours × hourly rate
        </div>
      </div>
    </div>
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

// AuditTimeline — chronological log of every state event on this
// invoice. Visible to both contractor and approver so the history
// is plain. We rebuild this from the row's stored timestamps
// rather than maintaining a separate audit table — every status
// transition has its own dedicated column already.
function AuditTimeline({ data }) {
  const events = []
  if (data.submitted_at) {
    events.push({
      ts: data.submitted_at,
      label: 'Submitted',
      sub: data.contractor?.full_name ? `by ${data.contractor.full_name}` : null,
      tone: 'amber',
    })
  }
  if (data.revoked_at) {
    events.push({
      ts: data.revoked_at,
      label: 'Revoked by contractor',
      sub: 'The contractor pulled this submission back. They may have resubmitted in a separate row.',
      tone: 'neutral',
    })
  }
  if (data.reviewed_at && data.status === 'declined') {
    events.push({
      ts: data.reviewed_at,
      label: 'Declined',
      sub: data.reviewer?.full_name
        ? `by ${data.reviewer.full_name}${data.decline_reason ? ` — ${data.decline_reason}` : ''}`
        : data.decline_reason || null,
      tone: 'red',
    })
  }
  if (data.reviewed_at && data.status === 'approved') {
    events.push({
      ts: data.reviewed_at,
      label: 'Approved',
      sub: data.reviewer?.full_name ? `by ${data.reviewer.full_name}` : null,
      tone: 'green',
    })
  }
  if (data.xero_synced_at) {
    events.push({
      ts: data.xero_synced_at,
      label: 'Forwarded to Xero',
      sub: 'Draft bill created in Bills to pay → Draft.',
      tone: 'green',
    })
  }
  // Sort newest-last (chronological top-down).
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
    tone === 'green' ? 'bg-green-400' :
    tone === 'red' ? 'bg-red-400' :
    tone === 'amber' ? 'bg-amber-400' :
    'bg-un1t-subtle'
  return <span className={`inline-block w-2 h-2 rounded-full mt-1.5 shrink-0 ${cls}`} />
}
