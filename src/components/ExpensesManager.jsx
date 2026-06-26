'use client'

// FTE-EXPENSES.1 — role-aware claim list + new-claim wizard.
//
// One component instead of three because the data model + actions
// overlap heavily. The render branches on (viewer_role, claim.status)
// to show appropriate actions. Mirrors the structure of
// InvoicesManager but lighter — no Xero status badges, no scheduled-
// hours snapshots (those are contractor-specific).

import { useEffect, useMemo, useState } from 'react'
import { dublinTodayStr } from '@/lib/dublin-time'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from '@/lib/fte-expenses'
import {
  Plus, Loader2, AlertCircle, X, ChevronRight,
  Trash2, Send, RotateCcw, ThumbsUp, ThumbsDown, Eye,
} from 'lucide-react'

const STATUS_LABEL = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved',
  // INVOICES-QUEUE.1 — owner has approved; bookkeeper now signs
  // off in /invoices before the Xero forward. From the submitter's
  // POV this is the terminal happy-path state — nothing more for
  // them to do. Short label here; the detail panel below renders
  // the longer explanatory copy.
  awaiting_accountant_review: 'With accountant',
  declined: 'Declined', revoked: 'Revoked',
}
const STATUS_TONE = {
  draft:     'bg-un1t-border/30 text-un1t-subtle',
  submitted: 'bg-amber-500/20 text-amber-300',
  approved:  'bg-emerald-500/20 text-emerald-300',
  // Same green palette as approved — both are happy-path post-
  // approval states. The label difference (With accountant) tells
  // the submitter where the claim actually sits.
  awaiting_accountant_review: 'bg-emerald-500/20 text-emerald-300',
  declined:  'bg-red-500/20 text-red-300',
  revoked:   'bg-un1t-border/30 text-un1t-muted',
}

export default function ExpensesManager({ userId, isFte, isApprover, locations }) {
  const [tab, setTab] = useState(isApprover ? 'submitted' : 'all')
  const [claims, setClaims] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null) // claim id
  const [showNew, setShowNew] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (tab !== 'all') params.set('status', tab)
      const r = await fetch(`/api/expenses?${params}`)
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setClaims(j.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = useMemo(() => {
    if (isApprover && !isFte) {
      return [
        { key: 'submitted', label: 'Awaiting review' },
        { key: 'approved',  label: 'Approved' },
        { key: 'declined',  label: 'Declined' },
        { key: 'all',       label: 'All' },
      ]
    }
    if (isFte && !isApprover) {
      return [
        { key: 'all',       label: 'My claims' },
        { key: 'draft',     label: 'Drafts' },
        { key: 'submitted', label: 'Awaiting review' },
        { key: 'approved',  label: 'Approved' },
      ]
    }
    return [
      { key: 'submitted', label: 'Awaiting review' },
      { key: 'all',       label: 'All' },
      { key: 'approved',  label: 'Approved' },
      { key: 'declined',  label: 'Declined' },
    ]
  }, [isFte, isApprover])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-un1t-surface border border-un1t-border rounded-md p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-xs px-3 py-1.5 rounded ${
                tab === t.key ? 'bg-un1t-text text-un1t-bg font-semibold' : 'text-un1t-subtle hover:text-un1t-text'
              }`}
            >{t.label}</button>
          ))}
        </div>
        {isFte && (
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent"
          >
            <Plus size={12} /> New claim
          </button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="space-y-2">
          {claims.length === 0 && (
            <div className="text-sm text-un1t-subtle bg-un1t-surface border border-un1t-border rounded p-4 text-center">
              No claims in this view.
            </div>
          )}
          {claims.map((c) => (
            <ClaimRow
              key={c.id}
              claim={c}
              userId={userId}
              expanded={expanded === c.id}
              onExpand={() => setExpanded(expanded === c.id ? null : c.id)}
              onChange={load}
            />
          ))}
        </div>
      )}

      {showNew && (
        <NewClaimModal
          locations={locations}
          onClose={() => setShowNew(false)}
          onCreated={(claimId) => { setShowNew(false); setExpanded(claimId); load() }}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------------
// One claim row in the list. Collapsed shows summary; expanded shows
// items + actions.
// -------------------------------------------------------------------
function ClaimRow({ claim, userId, expanded, onExpand, onChange }) {
  const isMine = claim.profile_id === userId
  const isDraft = claim.status === 'draft'
  const isSubmitted = claim.status === 'submitted'
  const periodLbl = formatPeriod(claim.period_start)
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-md">
      <button
        onClick={onExpand}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-un1t-border/10"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChevronRight size={14} className={`text-un1t-subtle transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-un1t-text">{periodLbl}</span>
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${STATUS_TONE[claim.status]}`}>
                {STATUS_LABEL[claim.status]}
              </span>
            </div>
            <div className="text-xs text-un1t-subtle truncate">
              {claim.profile?.full_name || '—'} · {claim.location?.name || '—'} · {claim.item_count} item{claim.item_count === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0 ml-3">
          <div className="text-sm font-semibold text-un1t-text">€{Number(claim.total_amount).toFixed(2)}</div>
          <div className="text-[11px] text-un1t-muted">incl. €{Number(claim.total_vat_amount).toFixed(2)} VAT</div>
        </div>
      </button>
      {expanded && (
        <ClaimDetail
          claimId={claim.id}
          canEdit={isMine && isDraft}
          canSubmit={isMine && isDraft}
          canRevoke={isMine && isSubmitted}
          canApprove={!isMine && isSubmitted}
          onChange={onChange}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------------
// Expanded claim view — items table + actions.
// -------------------------------------------------------------------
function ClaimDetail({ claimId, canEdit, canSubmit, canRevoke, canApprove, onChange }) {
  const [claim, setClaim] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [addingItem, setAddingItem] = useState(false)

  async function load() {
    setError(null)
    try {
      const r = await fetch(`/api/expenses/${claimId}`)
      const j = await r.json()
      if (!j.success) throw new Error(j.error)
      setClaim(j.data)
    } catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [claimId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function action(path, body, method = 'POST') {
    setBusy(true); setError(null)
    try {
      const r = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || `Failed (${r.status})`)
      await load()
      onChange?.()
      return j
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  async function deleteItem(itemId) {
    if (!confirm('Remove this item?')) return
    await action(`/api/expenses/${claimId}/items/${itemId}`, null, 'DELETE')
  }
  async function viewReceipt(itemId) {
    try {
      const r = await fetch(`/api/expenses/${claimId}/items/${itemId}/receipt`)
      const j = await r.json()
      if (!j.success) throw new Error(j.error)
      window.open(j.url, '_blank', 'noopener')
    } catch (e) { setError(e.message) }
  }

  if (!claim) {
    return <div className="p-4 text-xs text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading…</div>
  }

  return (
    <div className="border-t border-un1t-border bg-un1t-bg/30 p-4 space-y-3">
      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded p-2 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {claim.notes && (
        <div className="text-xs text-un1t-subtle bg-un1t-surface border border-un1t-border rounded p-2">
          <strong className="text-un1t-text">Notes:</strong> {claim.notes}
        </div>
      )}

      {claim.status === 'declined' && claim.decline_reason && (
        <div className="text-xs text-red-300 bg-red-950/30 border border-red-900/50 rounded p-2">
          <strong>Decline reason:</strong> {claim.decline_reason}
        </div>
      )}

      {/* INVOICES-QUEUE.1 — explain the new accountant-handoff
          state so the submitter doesn't wonder why their claim is
          "approved" but not yet in Xero. Renders only on the
          submitter's own claim (approvers viewing don't need this
          copy — they already understand the queue handoff). */}
      {claim.status === 'awaiting_accountant_review' && claim.viewer_role === 'self' && (
        <div className="text-xs text-emerald-200 bg-emerald-950/30 border border-emerald-900/50 rounded p-2">
          <strong>Approved by your manager.</strong> Awaiting accountant sign-off before forwarding to Xero — no further action needed from you.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-un1t-subtle text-[10px] uppercase tracking-wider border-b border-un1t-border">
              <th className="text-left p-2">Date</th>
              <th className="text-left p-2">Category</th>
              <th className="text-left p-2">Vendor</th>
              <th className="text-left p-2">Description</th>
              <th className="text-right p-2">Amount</th>
              <th className="text-right p-2">VAT</th>
              <th className="text-center p-2">Receipt</th>
              {canEdit && <th className="p-2 w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {claim.items.length === 0 && (
              <tr><td colSpan={canEdit ? 8 : 7} className="p-4 text-center text-un1t-subtle text-sm">No items yet.</td></tr>
            )}
            {claim.items.map((it) => (
              <tr key={it.id} className="border-b border-un1t-border/40">
                <td className="p-2 whitespace-nowrap font-mono text-[11px]">{it.expense_date}</td>
                <td className="p-2">{EXPENSE_CATEGORY_LABELS[it.category]}</td>
                <td className="p-2">{it.vendor || '—'}</td>
                <td className="p-2 truncate max-w-xs">{it.description || '—'}</td>
                <td className="p-2 text-right">€{Number(it.amount).toFixed(2)}</td>
                <td className="p-2 text-right text-un1t-subtle">€{Number(it.vat_amount).toFixed(2)}</td>
                <td className="p-2 text-center">
                  {it.receipt_path ? (
                    <button onClick={() => viewReceipt(it.id)} className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
                      <Eye size={11} /> View
                    </button>
                  ) : <span className="text-un1t-muted">—</span>}
                </td>
                {canEdit && (
                  <td className="p-2">
                    <button onClick={() => deleteItem(it.id)} disabled={busy} className="text-un1t-subtle hover:text-red-400 disabled:opacity-40"><Trash2 size={12} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-un1t-border font-semibold">
              <td colSpan={4} className="p-2 text-right text-un1t-subtle">Total</td>
              <td className="p-2 text-right">€{Number(claim.total_amount).toFixed(2)}</td>
              <td className="p-2 text-right">€{Number(claim.total_vat_amount).toFixed(2)}</td>
              <td className="p-2"></td>
              {canEdit && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        {canEdit && (
          addingItem ? (
            <AddItemForm claimId={claimId} onCancel={() => setAddingItem(false)} onSaved={() => { setAddingItem(false); load(); onChange?.() }} />
          ) : (
            <button onClick={() => setAddingItem(true)} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-medium hover:bg-un1t-accent">
              <Plus size={12} /> Add item
            </button>
          )
        )}

        {canSubmit && claim.item_count > 0 && !addingItem && (
          <button
            onClick={() => action(`/api/expenses/${claimId}/submit`)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-emerald-500/80 text-white font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            <Send size={12} /> Submit for approval
          </button>
        )}

        {canRevoke && !addingItem && (
          <button
            onClick={() => action(`/api/expenses/${claimId}/revoke`)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-border/40 text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          >
            <RotateCcw size={12} /> Revoke
          </button>
        )}

        {canApprove && (
          <>
            <button
              onClick={() => action(`/api/expenses/${claimId}/approve`)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50"
            >
              <ThumbsUp size={12} /> Approve
            </button>
            <DeclineButton
              onConfirm={(reason) => action(`/api/expenses/${claimId}/decline`, { reason })}
              busy={busy}
            />
          </>
        )}
      </div>
    </div>
  )
}

function DeclineButton({ onConfirm, busy }) {
  const [show, setShow] = useState(false)
  const [reason, setReason] = useState('')
  if (!show) {
    return (
      <button onClick={() => setShow(true)} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-red-500/80 text-white font-medium hover:bg-red-500">
        <ThumbsDown size={12} /> Decline
      </button>
    )
  }
  return (
    <div className="flex items-center gap-2 flex-1 min-w-[300px]">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Decline reason (required)"
        className="flex-1 text-xs bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-un1t-text"
        maxLength={1000}
      />
      <button
        onClick={() => reason.trim() && onConfirm(reason.trim()).then(() => { setShow(false); setReason('') })}
        disabled={busy || !reason.trim()}
        className="text-xs px-3 py-1.5 rounded-md bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-50"
      >Confirm</button>
      <button onClick={() => { setShow(false); setReason('') }} className="text-xs text-un1t-subtle hover:text-un1t-text"><X size={14} /></button>
    </div>
  )
}

// -------------------------------------------------------------------
// New claim modal — picks month + location + optional notes.
// -------------------------------------------------------------------
function NewClaimModal({ locations, onClose, onCreated }) {
  const today = new Date()
  const defaultMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
  const [month, setMonth] = useState(defaultMonth)
  const [locationId, setLocationId] = useState(locations[0]?.id || '')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    if (!locationId) { setError('Pick a location.'); return }
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ month, location_id: locationId, notes: notes || null }),
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error)
      onCreated(j.data.id)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 max-w-md w-full space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-un1t-text">New expense claim</h2>
        <p className="text-xs text-un1t-subtle">Start a draft for a month. You can add line items and submit when ready.</p>
        <Field label="Month">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text" />
        </Field>
        <Field label="Location">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text">
            <option value="">— Pick —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text" />
        </Field>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 text-un1t-subtle hover:text-un1t-text">Cancel</button>
          <button onClick={submit} disabled={busy || !locationId} className="text-xs px-4 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Create draft'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------
// Add item form — inline under a claim. Multipart upload.
// -------------------------------------------------------------------
function AddItemForm({ claimId, onCancel, onSaved }) {
  const today = dublinTodayStr()
  const [form, setForm] = useState({
    expense_date: today, category: 'travel', vendor: '', description: '',
    amount: '', vat_amount: '', receipt: null,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // INVOICES-QUEUE.1 PR 3 — receipt-side Claude Vision OCR removed.
  // OCR now runs exclusively inside the central invoices queue
  // (bookkeeper clicks Analyse). The submitter just attaches the
  // receipt and types the fields manually; the bookkeeper's
  // Claude run later happens against the same receipt file. This
  // removes the per-feature OCR cost surface and keeps extraction
  // in one place for cost visibility + caching (PR 3 design).

  function handleReceiptChange(file) {
    setForm((prev) => ({ ...prev, receipt: file || null }))
  }

  async function submit() {
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.set('expense_date', form.expense_date)
      fd.set('category', form.category)
      fd.set('amount', String(form.amount || ''))
      fd.set('vat_amount', String(form.vat_amount || 0))
      if (form.vendor) fd.set('vendor', form.vendor)
      if (form.description) fd.set('description', form.description)
      if (form.receipt) fd.set('receipt', form.receipt)
      const r = await fetch(`/api/expenses/${claimId}/items`, { method: 'POST', body: fd })
      const j = await r.json()
      if (!j.success) throw new Error(j.error)
      onSaved()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded p-3 w-full space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Field label="Date">
          <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text" />
        </Field>
        <Field label="Category">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text">
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
          </select>
        </Field>
        <Field label="Amount (€)">
          <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text" />
        </Field>
        <Field label="VAT (€)">
          <input type="number" step="0.01" min="0" value={form.vat_amount} onChange={(e) => setForm({ ...form, vat_amount: e.target.value })} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text" />
        </Field>
        <Field label="Vendor (optional)">
          <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} maxLength={200} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text" />
        </Field>
        <Field label="Description (optional)">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-xs text-un1t-text" />
        </Field>
        <Field label="Receipt (PDF/image)">
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => handleReceiptChange(e.target.files?.[0] || null)}
            className="w-full text-xs text-un1t-subtle"
          />
        </Field>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={submit} disabled={busy || !form.amount} className="text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Add item'}
        </button>
        <button onClick={onCancel} className="text-xs text-un1t-subtle hover:text-un1t-text">Cancel</button>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-1">{label}</div>
      {children}
    </label>
  )
}

function formatPeriod(periodStart) {
  try {
    return new Date(`${periodStart}T00:00:00Z`).toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  } catch { return periodStart }
}
