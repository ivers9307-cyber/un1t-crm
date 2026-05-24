'use client'

// INVOICES.1 — operator inbox component.
//
// Tabs:
//   • Quality review (status=received)
//   • Data review    (status in extracted, data_approved, quality_approved [if Extract failed])
//   • Forwarded      (status=forwarded)
//   • Rejected       (status=rejected)
//
// Each tab is a master-detail layout: list on the left, selected
// row's detail on the right. The detail panel changes shape based
// on the row's status:
//   • received          → big attachment preview + Approve / Reject buttons
//   • quality_approved  → "Extract with Claude Vision" button + retry on failure
//   • extracted         → side-by-side: attachment preview + editable extracted-fields
//                         form + Approve / Reject buttons
//   • data_approved     → "Forwarding to Xero…" or retry button if forward failed
//   • forwarded         → read-only summary with Xero MessageID
//   • rejected          → read-only summary with reason + stage; Delete button

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
// BOOKKEEPER-APPROVALS.1 — read `?focus=<id>` so the drill-in from
// /approvals lands on the right row + correct tab.
import { useSearchParams } from 'next/navigation'
import { INVOICE_CATEGORIES } from '@/lib/invoice-extraction'
import XeroAccountPicker from '@/components/invoices/XeroAccountPicker'
import XeroContactPicker from '@/components/invoices/XeroContactPicker'

// INVOICES.3 — friendly labels for the category dropdown. Keys
// match the enum in INVOICE_CATEGORIES exactly; the underscore →
// space + Title Case mapping is done here so the UI stays readable.
const CATEGORY_LABEL = {
  utilities: 'Utilities',
  cleaning: 'Cleaning',
  equipment: 'Equipment',
  marketing: 'Marketing',
  insurance: 'Insurance',
  rent: 'Rent',
  maintenance: 'Maintenance & Repairs',
  professional_services: 'Professional services',
  staff_training: 'Staff training',
  office_supplies: 'Office supplies',
  software: 'Software & subscriptions',
  bank_fees: 'Bank & merchant fees',
  other: 'Other',
}

// INVOICES-QUEUE.1 PR 2 — source_type is the primary nav. Status
// becomes a secondary filter via STATUS_FILTERS. "Awaiting action"
// (the default) means everything except forwarded + rejected — i.e.
// rows that need bookkeeper attention.
const SOURCE_TABS = [
  { key: 'all',                label: 'All',          sourceTypes: null },
  { key: 'supplier_email',     label: 'Supplier',     sourceTypes: ['supplier_email'] },
  { key: 'contractor_invoice', label: 'Contractor',   sourceTypes: ['contractor_invoice'] },
  { key: 'fte_expense_item',   label: 'Expenses',     sourceTypes: ['fte_expense_item'] },
  { key: 'car_document',       label: 'Car documents',sourceTypes: ['car_document'] },
]

const STATUS_FILTERS = [
  { key: 'pending',   label: 'Awaiting action', statuses: ['received', 'quality_approved', 'extracted', 'data_approved'] },
  { key: 'forwarded', label: 'Forwarded',       statuses: ['forwarded'] },
  { key: 'rejected',  label: 'Rejected',        statuses: ['rejected'] },
  { key: 'all',       label: 'All',             statuses: null },
]

const SOURCE_TYPE_LABEL = {
  supplier_email: 'Supplier email',
  contractor_invoice: 'Contractor invoice',
  fte_expense_item: 'Employee expense',
  car_document: 'Car document',
}

const SOURCE_TYPE_TONE = {
  supplier_email:     'bg-blue-500/20 text-blue-300 border-blue-500/40',
  contractor_invoice: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  fte_expense_item:   'bg-orange-500/20 text-orange-300 border-orange-500/40',
  car_document:       'bg-teal-500/20 text-teal-300 border-teal-500/40',
}

function formatBytes(n) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function InvoicesInbox({ locations, isMaster, isBookkeeper = false }) {
  // BOOKKEEPER-APPROVALS.1 — `?focus=<id>` arrives when the user
  // clicked a row in /approvals. We seed selectedId from it and
  // remember whether we've already consumed it so the focus is
  // sticky across re-fetches (but the user can still click off it).
  const searchParams = useSearchParams()
  const focusId = searchParams?.get('focus') || null
  const [sourceTab, setSourceTab] = useState('all')
  const [statusFilter, setStatusFilter] = useState('pending')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(focusId)
  const [locationFilter, setLocationFilter] = useState('all')
  // INVOICES-QUEUE.1 PR 2 — multi-select state for bulk actions.
  // Selection persists across tab switches (Set tracks ids; rows
  // not in the current filter just don't render their checkbox).
  const [bulkSelection, setBulkSelection] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(null)
  const [bulkError, setBulkError] = useState(null)
  const [bulkSummary, setBulkSummary] = useState(null)

  const activeStatuses = useMemo(
    () => STATUS_FILTERS.find((s) => s.key === statusFilter)?.statuses,
    [statusFilter],
  )
  const activeSourceTypes = useMemo(
    () => SOURCE_TABS.find((t) => t.key === sourceTab)?.sourceTypes,
    [sourceTab],
  )

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (activeStatuses) params.set('status', activeStatuses.join(','))
      if (activeSourceTypes) params.set('source_type', activeSourceTypes.join(','))
      if (locationFilter !== 'all') params.set('location_id', locationFilter)
      const res = await fetch(`/api/invoices-inbox?${params.toString()}`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setRows(j.data || [])
      setSelectedId((prev) => {
        // Prefer the URL-supplied focus on first load if it's in
        // the result set; otherwise keep the user's last pick if
        // still visible; otherwise default to the top row.
        const desired = prev || focusId
        if (desired && (j.data || []).some((r) => r.id === desired)) return desired
        return (j.data || [])[0]?.id || null
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [activeStatuses, activeSourceTypes, locationFilter, focusId])

  useEffect(() => { loadRows() }, [loadRows])

  // BOOKKEEPER-APPROVALS.1 — if we arrived with a `?focus=<id>` but
  // the row isn't in the current view (e.g. drilled in from
  // /approvals while we're on the Forwarded tab), broaden filters
  // once so the row IS visible. Runs after the first load resolves.
  useEffect(() => {
    if (!focusId || loading) return
    if (rows.some((r) => r.id === focusId)) return
    // Row not in view — open it up.
    setStatusFilter('all')
    setSourceTab('all')
    if (locationFilter !== 'all') setLocationFilter('all')
  // We want this to fire ONCE the first time we discover the row
  // is missing; subsequent rows changes shouldn't keep re-opening
  // filters. The dependency on `rows.length === 0` would be too
  // aggressive; key on rows identity instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, loading])

  const selected = rows.find((r) => r.id === selectedId) || null

  // Tab counts — quick lookup so each tab's badge reflects pending
  // work without re-fetching per tab. We re-derive whenever rows
  // change. Caveat: the counts reflect what's CURRENTLY loaded
  // (post-filter on status + location). For the cross-tab counts
  // to be fully accurate would require a separate count endpoint;
  // for PR 2 the local count is "close enough" — the operator
  // clicks a tab to see the real list anyway.
  const sourceCounts = useMemo(() => {
    const acc = { all: rows.length }
    for (const r of rows) acc[r.source_type] = (acc[r.source_type] || 0) + 1
    return acc
  }, [rows])

  // Bulk-action helpers.
  function toggleSelection(id) {
    setBulkSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function clearSelection() { setBulkSelection(new Set()); setBulkSummary(null) }
  function selectAllVisible() {
    const next = new Set(bulkSelection)
    for (const r of rows) next.add(r.id)
    setBulkSelection(next)
  }
  async function runBulk(action, body) {
    setBulkBusy(action)
    setBulkError(null)
    setBulkSummary(null)
    try {
      const res = await fetch(`/api/invoices-inbox/bulk-${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || `Bulk ${action} failed`)
      setBulkSummary({ action, ...j.data })
      await loadRows()
    } catch (e) {
      setBulkError(e.message)
    } finally {
      setBulkBusy(null)
    }
  }

  const selectedRows = useMemo(
    () => rows.filter((r) => bulkSelection.has(r.id)),
    [rows, bulkSelection],
  )

  return (
    <div className="space-y-6">
      <ForwardingAddresses locations={locations} />

      {/* Source-type tabs — primary navigation */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 border border-un1t-grey rounded-lg p-1 bg-un1t-black/40 flex-wrap">
          {SOURCE_TABS.map((t) => {
            const count = sourceCounts[t.key === 'all' ? 'all' : t.sourceTypes[0]] || 0
            const isActive = sourceTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSourceTab(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-2 ${
                  isActive
                    ? 'bg-un1t-white text-un1t-black font-medium'
                    : 'text-un1t-light hover:text-un1t-white'
                }`}
              >
                {t.label}
                {count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full ${
                    isActive ? 'bg-un1t-black text-un1t-white' : 'bg-un1t-grey/40 text-un1t-light'
                  }`}>{count}</span>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Status filter (secondary) */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-un1t-black border border-un1t-grey rounded-md px-3 py-1.5 text-sm text-un1t-white"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          {locations.length > 1 && (
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="bg-un1t-black border border-un1t-grey rounded-md px-3 py-1.5 text-sm text-un1t-white"
            >
              <option value="all">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-6">
        <InboxList
          rows={rows}
          loading={loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          isMaster={isMaster}
          isBookkeeper={isBookkeeper}
          bulkSelection={bulkSelection}
          onToggleSelect={toggleSelection}
          onSelectAll={selectAllVisible}
          onClearSelection={clearSelection}
        />
        <InboxDetail
          row={selected}
          onChanged={loadRows}
          isMaster={isMaster}
        />
      </div>

      {/* Bookkeeper-gated floating action bar — sticks to the bottom
          of the viewport when rows are selected. Hidden entirely for
          non-bookkeepers (no point teasing actions they can't run). */}
      {isBookkeeper && bulkSelection.size > 0 && (
        <BulkActionBar
          selectedCount={bulkSelection.size}
          selectedRows={selectedRows}
          busy={bulkBusy}
          error={bulkError}
          summary={bulkSummary}
          onAnalyse={() => runBulk('analyse', { ids: Array.from(bulkSelection) })}
          onSend={() => runBulk('send', { ids: Array.from(bulkSelection) })}
          onReject={(reason) => runBulk('reject', { ids: Array.from(bulkSelection), reason })}
          onClear={clearSelection}
        />
      )}
    </div>
  )
}

function ForwardingAddresses({ locations }) {
  if (!locations.length) return null
  return (
    <div className="border border-un1t-grey rounded-lg p-4 bg-un1t-black/40">
      <p className="text-xs uppercase tracking-wide text-un1t-light mb-2">Forwarding addresses</p>
      <ul className="space-y-1 text-sm">
        {locations.map((l) => (
          <li key={l.id} className="flex justify-between gap-3">
            <span className="text-un1t-white">{l.name}</span>
            {l.invoices_inbound_slug ? (
              <code className="text-un1t-light">{l.invoices_inbound_slug}-invoices@mail.un1tdublin.com</code>
            ) : (
              <Link href={`/settings/locations/${l.id}`} className="text-un1t-light underline">
                Configure forwarding slug
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function InboxList({
  rows, loading, selectedId, onSelect, isMaster, isBookkeeper,
  bulkSelection, onToggleSelect, onSelectAll, onClearSelection,
}) {
  const allVisibleSelected = rows.length > 0 && rows.every((r) => bulkSelection.has(r.id))
  return (
    <aside className="border border-un1t-grey rounded-lg overflow-hidden">
      <header className="px-3 py-2 border-b border-un1t-grey flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-un1t-light">
          {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
        </span>
        {isBookkeeper && rows.length > 0 && (
          <button
            type="button"
            onClick={allVisibleSelected ? onClearSelection : onSelectAll}
            className="text-xs text-un1t-light hover:text-un1t-white underline underline-offset-2"
          >
            {allVisibleSelected ? 'Clear selection' : 'Select all'}
          </button>
        )}
      </header>
      <ul className="divide-y divide-un1t-grey/50 max-h-[70vh] overflow-y-auto">
        {rows.length === 0 && !loading && (
          <li className="p-4 text-sm text-un1t-light">Nothing here.</li>
        )}
        {rows.map((r) => {
          const active = r.id === selectedId
          const checked = bulkSelection.has(r.id)
          return (
            <li key={r.id} className={checked ? 'bg-un1t-white/10' : ''}>
              <div className="flex items-stretch">
                {isBookkeeper && (
                  <label className="flex items-center pl-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSelect(r.id)}
                      // Stop the row click handler from firing when
                      // the operator clicks the checkbox itself.
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 accent-un1t-white"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(r.id)}
                  className={`flex-1 text-left p-3 transition-colors ${
                    active ? 'bg-un1t-white/10' : 'hover:bg-un1t-white/5'
                  }`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="text-sm font-medium text-un1t-white truncate">
                      {r.extracted_fields?.supplier_name || r.sender_email || '(no sender)'}
                    </div>
                    <StatusPill status={r.status} stage={r.rejected_stage} />
                  </div>
                  <div className="text-xs text-un1t-light truncate mt-1">
                    {r.subject || r.attachment_filename || '(no subject)'}
                  </div>
                  <div className="text-xs text-un1t-light mt-1 flex justify-between items-center gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <SourceTypePill source={r.source_type} />
                      <span className="truncate">{formatDateTime(r.received_at)}</span>
                    </span>
                    {isMaster && <span className="shrink-0">{r.location?.name}</span>}
                  </div>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function SourceTypePill({ source }) {
  const label = SOURCE_TYPE_LABEL[source] || source
  const tone = SOURCE_TYPE_TONE[source] || 'bg-un1t-grey/30 text-un1t-light border-un1t-grey'
  return (
    <span className={`text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 whitespace-nowrap ${tone}`}>
      {label}
    </span>
  )
}

function BulkActionBar({
  selectedCount, selectedRows, busy, error, summary,
  onAnalyse, onSend, onReject, onClear,
}) {
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  // Per-action eligibility — the backend skips bad rows anyway, but
  // disabling the buttons when zero selected rows match the action's
  // legal states is friendlier UX.
  const analysableCount = selectedRows.filter((r) =>
    ['quality_approved', 'extracted'].includes(r.status)).length
  const sendableCount = selectedRows.filter((r) =>
    ['extracted', 'data_approved'].includes(r.status) && r.extracted_fields).length
  const rejectableCount = selectedRows.filter((r) =>
    ['received', 'quality_approved', 'extracted', 'data_approved'].includes(r.status)).length

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-un1t-grey bg-un1t-black/95 backdrop-blur p-4">
      <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap">
        <span className="text-sm text-un1t-white font-medium">
          {selectedCount} selected
        </span>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <button
            type="button"
            disabled={analysableCount === 0 || !!busy}
            onClick={onAnalyse}
            className="px-3 py-1.5 text-sm rounded-md border border-un1t-grey text-un1t-white disabled:opacity-40"
            title={analysableCount === 0 ? 'No selected rows are eligible for analysis' : ''}
          >
            {busy === 'analyse' ? 'Analysing…' : `Analyse (${analysableCount})`}
          </button>
          <button
            type="button"
            disabled={sendableCount === 0 || !!busy}
            onClick={onSend}
            className="px-3 py-1.5 text-sm rounded-md bg-un1t-white text-un1t-black font-medium disabled:opacity-40"
            title={sendableCount === 0 ? 'No selected rows have extracted fields ready to send' : ''}
          >
            {busy === 'send' ? 'Sending…' : `Send to Xero (${sendableCount})`}
          </button>
          <button
            type="button"
            disabled={rejectableCount === 0 || !!busy}
            onClick={() => setShowRejectForm((v) => !v)}
            className="px-3 py-1.5 text-sm rounded-md border border-un1t-grey text-un1t-light disabled:opacity-40"
          >
            Reject ({rejectableCount})…
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-1.5 text-sm rounded-md text-un1t-light hover:text-un1t-white"
          >
            Clear
          </button>
        </div>
      </div>

      {showRejectForm && (
        <div className="max-w-7xl mx-auto mt-3 space-y-2 border border-un1t-grey rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-light">Reject reason (applied to all selected)</label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-black border border-un1t-grey rounded-md p-2 text-sm text-un1t-white"
            placeholder="e.g. Wrong attachment uploaded; duplicate of #1234; not an invoice"
          />
          <button
            type="button"
            disabled={!rejectReason.trim() || !!busy}
            onClick={() => { onReject(rejectReason.trim()); setShowRejectForm(false); setRejectReason('') }}
            className="px-3 py-1.5 text-sm rounded-md bg-red-500 text-white font-medium disabled:opacity-50"
          >
            {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
      )}

      {error && (
        <div className="max-w-7xl mx-auto mt-3 border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-2 text-xs">
          {error}
        </div>
      )}
      {summary && (
        <div className="max-w-7xl mx-auto mt-3 border border-un1t-grey rounded-lg p-2 text-xs text-un1t-light flex flex-wrap gap-3">
          <strong className="text-un1t-white">{summary.action} result:</strong>
          {Object.entries(summary.counts || {}).map(([k, v]) => (
            <span key={k}>{k}: <strong className="text-un1t-white">{v}</strong></span>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status, stage }) {
  const map = {
    received:         { label: 'Awaiting review',  cls: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' },
    quality_approved: { label: 'Awaiting extract', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
    extracted:        { label: 'Awaiting data',    cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
    data_approved:    { label: 'Awaiting send',    cls: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
    forwarded:        { label: 'Sent to Xero',     cls: 'bg-green-500/20 text-green-300 border-green-500/40' },
    rejected:         { label: `Rejected (${stage || 'quality'})`, cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
  }
  const it = map[status] || { label: status, cls: 'bg-un1t-grey/30 text-un1t-light border-un1t-grey' }
  return (
    <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap ${it.cls}`}>
      {it.label}
    </span>
  )
}

function InboxDetail({ row, onChanged }) {
  const [attachment, setAttachment] = useState(null)
  const [attLoading, setAttLoading] = useState(false)
  const [busy, setBusy] = useState(null) // 'approve' | 'reject' | 'extract' | 'send' | 'delete'
  const [actionError, setActionError] = useState(null)

  // Load the signed URL whenever the selected row changes.
  useEffect(() => {
    setAttachment(null)
    setActionError(null)
    if (!row?.id || !row.attachment_path) return
    setAttLoading(true)
    fetch(`/api/invoices-inbox/${row.id}/attachment`)
      .then((r) => r.json())
      .then((j) => { if (j.success) setAttachment(j.data) })
      .finally(() => setAttLoading(false))
  }, [row?.id, row?.attachment_path])

  if (!row) {
    return (
      <section className="border border-un1t-grey rounded-lg p-6 text-sm text-un1t-light min-h-[200px] flex items-center justify-center">
        Select an invoice from the list to review.
      </section>
    )
  }

  async function postAction(path, body) {
    setBusy(path)
    setActionError(null)
    try {
      const res = await fetch(`/api/invoices-inbox/${row.id}/${path}`, {
        method: body ? 'POST' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Action failed')
      onChanged()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function patchFields(extracted_fields) {
    setBusy('fields')
    setActionError(null)
    try {
      const res = await fetch(`/api/invoices-inbox/${row.id}/fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extracted_fields }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Save failed')
      onChanged()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteRow() {
    if (!confirm('Permanently delete this rejected invoice?')) return
    setBusy('delete')
    setActionError(null)
    try {
      const res = await fetch(`/api/invoices-inbox/${row.id}`, { method: 'DELETE' })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Delete failed')
      onChanged()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border border-un1t-grey rounded-lg p-5 space-y-5">
      <DetailHeader row={row} />

      {actionError && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">
          {actionError}
        </div>
      )}

      <AttachmentPreview attachment={attachment} loading={attLoading} mime={row.attachment_mime_type} />

      {row.status === 'received' && (
        <StageOneActions
          busy={busy}
          onApprove={() => postAction('quality-approve')}
          onReject={(reason) => postAction('quality-reject', { reason })}
        />
      )}

      {row.status === 'quality_approved' && (
        <ExtractAction
          busy={busy}
          extractionError={row.extraction_error}
          onExtract={() => postAction('extract')}
        />
      )}

      {(row.status === 'extracted' || row.status === 'data_approved') && (
        <StageTwoBlock
          row={row}
          busy={busy}
          onSaveFields={patchFields}
          onApprove={() => postAction('data-approve')}
          onReject={(reason) => postAction('data-reject', { reason })}
        />
      )}

      {row.status === 'forwarded' && (
        <ForwardedSummary row={row} />
      )}

      {row.status === 'rejected' && (
        <RejectedSummary row={row} busy={busy} onDelete={deleteRow} />
      )}
    </section>
  )
}

function DetailHeader({ row }) {
  return (
    <header className="space-y-1">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-un1t-white">
          {row.extracted_fields?.supplier_name || row.sender_email || '(no sender)'}
        </h2>
        <StatusPill status={row.status} stage={row.rejected_stage} />
      </div>
      <p className="text-sm text-un1t-light">{row.subject || '(no subject)'}</p>
      <p className="text-xs text-un1t-light">
        Received {formatDateTime(row.received_at)} · {row.location?.name || 'unknown location'} · {formatBytes(row.attachment_size_bytes)}
      </p>
    </header>
  )
}

function AttachmentPreview({ attachment, loading, mime }) {
  if (loading) {
    return <div className="border border-un1t-grey rounded-lg p-4 text-sm text-un1t-light">Loading attachment…</div>
  }
  if (!attachment) {
    return <div className="border border-un1t-grey rounded-lg p-4 text-sm text-un1t-light">No attachment available.</div>
  }
  const isPdf = mime === 'application/pdf'
  return (
    <div className="border border-un1t-grey rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-un1t-grey flex justify-between items-center text-xs">
        <span className="text-un1t-light truncate">{attachment.filename}</span>
        <a href={attachment.url} target="_blank" rel="noreferrer" className="text-un1t-white underline">
          Open in new tab
        </a>
      </div>
      {isPdf ? (
        <iframe
          title="Invoice attachment"
          src={attachment.url}
          className="w-full bg-un1t-black"
          style={{ height: '60vh' }}
        />
      ) : (
        <img src={attachment.url} alt="Invoice attachment" className="w-full max-h-[60vh] object-contain bg-un1t-black" />
      )}
    </div>
  )
}

function StageOneActions({ busy, onApprove, onReject }) {
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <div className="space-y-3">
      <p className="text-sm text-un1t-light">
        Quality review — is this attachment legible and a real invoice for this location?
        Approving runs Claude Vision next (which costs API tokens), so reject anything that isn't an invoice or isn't readable.
      </p>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          disabled={!!busy}
          onClick={onApprove}
          className="px-4 py-2 rounded-md bg-un1t-white text-un1t-black font-medium disabled:opacity-50"
        >
          {busy === 'quality-approve' ? 'Approving…' : 'Approve quality'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowRejectForm((v) => !v)}
          className="px-4 py-2 rounded-md border border-un1t-grey text-un1t-white disabled:opacity-50"
        >
          Reject…
        </button>
      </div>
      {showRejectForm && (
        <div className="space-y-2 border border-un1t-grey rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-light">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-black border border-un1t-grey rounded-md p-2 text-sm text-un1t-white"
            placeholder="e.g. Not a real invoice / unreadable / wrong location"
          />
          <button
            type="button"
            disabled={!reason.trim() || !!busy}
            onClick={() => onReject(reason.trim())}
            className="px-4 py-2 rounded-md bg-red-500 text-white font-medium disabled:opacity-50"
          >
            {busy === 'quality-reject' ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
      )}
    </div>
  )
}

function ExtractAction({ busy, extractionError, onExtract }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-un1t-light">
        Quality approved. Run Claude Vision to extract supplier, amount, and line items.
        {extractionError && ' Previous run failed — see the error below.'}
      </p>
      {extractionError && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-xs">
          {extractionError}
        </div>
      )}
      <button
        type="button"
        disabled={!!busy}
        onClick={onExtract}
        className="px-4 py-2 rounded-md bg-un1t-white text-un1t-black font-medium disabled:opacity-50"
      >
        {busy === 'extract' ? 'Extracting…' : 'Extract with Claude Vision'}
      </button>
    </div>
  )
}

function StageTwoBlock({ row, busy, onSaveFields, onApprove, onReject }) {
  const initial = row.extracted_fields || {}
  const [fields, setFields] = useState(initial)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [reason, setReason] = useState('')
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial)
  // Reset when row changes.
  useEffect(() => { setFields(row.extracted_fields || {}) }, [row.id, row.extracted_fields])

  function setField(k, v) { setFields((f) => ({ ...f, [k]: v })) }

  // SUPPLIER-MEMORY.1 — when a supplier is picked by hand, pull that
  // supplier's remembered coding and pre-fill any account / category
  // fields the operator hasn't already set. Extraction does this
  // server-side for an auto-matched supplier; this covers manual
  // picks (where the invoice spelled the name differently). Never
  // clobbers a value the operator already chose.
  async function applySupplierDefault(xeroContactId) {
    try {
      const res = await fetch(
        `/api/locations/${row.location_id}/xero/supplier-default?xero_contact_id=${encodeURIComponent(xeroContactId)}`
      )
      const j = await res.json()
      if (!j.success || !j.default) return
      setFields((f) => {
        const next = { ...f }
        if (j.default.xero_account_id && !f.xero_account_id) {
          next.xero_account_id = j.default.xero_account_id
          next.account_code = j.default.account_code || f.account_code || null
        }
        if (j.default.category && !f.category) next.category = j.default.category
        return next
      })
    } catch {
      /* best-effort — a memory miss must not disrupt the review */
    }
  }

  function numField(k) {
    const v = fields[k]
    return v == null ? '' : String(v)
  }
  function strField(k) {
    const v = fields[k]
    return v == null ? '' : String(v)
  }

  const isApproved = row.status === 'data_approved'

  return (
    <div className="space-y-4">
      <p className="text-sm text-un1t-light">
        Data review — confirm the extracted fields. Edit anything that's wrong. Approving sends the original attachment to Xero's bills email; Xero creates a draft bill from it.
      </p>

      {row.xero_error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">
          Xero forward failed: {row.xero_error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Supplier (label)" value={strField('supplier_name')}   onChange={(v) => setField('supplier_name', v)} />
        <FieldRow label="Invoice #"    value={strField('invoice_number')}  onChange={(v) => setField('invoice_number', v)} />
        <FieldRow label="Invoice date" value={strField('invoice_date')}    onChange={(v) => setField('invoice_date', v)} placeholder="YYYY-MM-DD" />
        <FieldRow label="Due date"     value={strField('due_date')}        onChange={(v) => setField('due_date', v)} placeholder="YYYY-MM-DD" />
        <FieldRow label="Currency"     value={strField('currency')}        onChange={(v) => setField('currency', v.toUpperCase())} />
        <FieldRow label="Subtotal"     value={numField('subtotal')}        onChange={(v) => setField('subtotal', v === '' ? null : Number(v))} type="number" />
        <FieldRow label="VAT / tax"    value={numField('tax_amount')}      onChange={(v) => setField('tax_amount', v === '' ? null : Number(v))} type="number" />
        <FieldRow label="Total"        value={numField('total')}           onChange={(v) => setField('total', v === '' ? null : Number(v))} type="number" />
        {/* INVOICES.3 — Claude-suggested category. Stays as a
            human-friendly hint that flows into the audit log.
            (Xero categorisation now driven by the account picker
            below — categories were a transitional INVOICES.3
            pattern from when there was no account picker.) */}
        <SelectRow
          label="Category (suggested)"
          value={strField('category')}
          onChange={(v) => setField('category', v || null)}
          options={INVOICE_CATEGORIES.map((k) => ({ value: k, label: CATEGORY_LABEL[k] || k }))}
        />
        {/* XERO-API.2 — Xero account picker (replaces the old free-
            text account_code field). Stores xero_account_id on
            extracted_fields so PR 3's /Invoices API push can wire
            up the LineItem to the right AccountCode. The legacy
            account_code field is also kept in sync from the
            picker's code so existing audit views still render. */}
        <XeroAccountPicker
          locationId={row.location_id}
          value={strField('xero_account_id') || null}
          onChange={(xid, full) => {
            setField('xero_account_id', xid || null)
            setField('account_code', full?.code || null)
          }}
        />
        {/* XERO-API.2 — Xero supplier picker. Stores a structured
            xero_contact_ref so the send step knows whether to
            attach an existing ContactID or create one inline. */}
        <XeroContactPicker
          locationId={row.location_id}
          initialName={strField('supplier_name')}
          value={fields.xero_contact_ref || null}
          onChange={(ref) => {
            setField('xero_contact_ref', ref)
            // Pull this supplier's remembered account / category.
            if (ref?.kind === 'existing' && ref.xero_contact_id) {
              applySupplierDefault(ref.xero_contact_id)
            }
          }}
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          disabled={!dirty || !!busy || isApproved}
          onClick={() => onSaveFields(fields)}
          className="px-4 py-2 rounded-md border border-un1t-grey text-un1t-white disabled:opacity-50"
        >
          {busy === 'fields' ? 'Saving…' : 'Save edits'}
        </button>
        {/* XERO-API.2 — both Xero refs must be picked before we
            can send. Surface why the button is disabled in the
            title so the bookkeeper isn't left guessing. */}
        {(() => {
          const hasAccount = !!fields.xero_account_id
          const hasContact = !!fields.xero_contact_ref
          const missing = []
          if (!hasAccount) missing.push('Xero account')
          if (!hasContact) missing.push('Xero supplier')
          const gate = missing.length > 0
          const title = dirty
            ? 'Save edits before approving'
            : gate
              ? `Pick a ${missing.join(' + ')} before sending`
              : ''
          return (
            <button
              type="button"
              disabled={dirty || !!busy || gate}
              onClick={onApprove}
              className="px-4 py-2 rounded-md bg-un1t-white text-un1t-black font-medium disabled:opacity-50"
              title={title}
            >
              {busy === 'data-approve' ? (isApproved ? 'Retrying send…' : 'Approving + sending…') : (isApproved ? 'Retry send to Xero' : 'Approve + send to Xero')}
            </button>
          )
        })()}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowRejectForm((v) => !v)}
          className="px-4 py-2 rounded-md border border-un1t-grey text-un1t-white disabled:opacity-50"
        >
          Reject…
        </button>
      </div>
      {showRejectForm && (
        <div className="space-y-2 border border-un1t-grey rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-light">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-black border border-un1t-grey rounded-md p-2 text-sm text-un1t-white"
            placeholder="e.g. Duplicate, wrong amount, not a real invoice"
          />
          <button
            type="button"
            disabled={!reason.trim() || !!busy}
            onClick={() => onReject(reason.trim())}
            className="px-4 py-2 rounded-md bg-red-500 text-white font-medium disabled:opacity-50"
          >
            {busy === 'data-reject' ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
      )}
    </div>
  )
}

function FieldRow({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wide text-un1t-light">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-un1t-black border border-un1t-grey rounded-md px-2 py-1.5 text-sm text-un1t-white"
        step={type === 'number' ? '0.01' : undefined}
      />
    </label>
  )
}

// INVOICES.3 — dropdown for the category field. Same outer shape
// as FieldRow so the grid lays out cleanly; empty option renders
// as "—" (null in the data).
function SelectRow({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wide text-un1t-light">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-un1t-black border border-un1t-grey rounded-md px-2 py-1.5 text-sm text-un1t-white"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function ForwardedSummary({ row }) {
  const f = row.extracted_fields || {}
  // XERO-API.3 — new rows have xero_bill_id + xero_deep_link_url.
  // Historical rows (forwarded via the old Postmark/Hubdoc path)
  // only have xero_email_message_id — render whichever is present.
  return (
    <div className="space-y-3">
      <div className="border border-green-500/40 bg-green-500/10 text-green-300 rounded-lg p-3 text-sm">
        <div>Sent to Xero at {formatDateTime(row.forwarded_at)}.</div>
        {row.xero_bill_id && (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            {row.xero_bill_number && (
              <span>Bill <code className="text-xs">{row.xero_bill_number}</code></span>
            )}
            {row.xero_deep_link_url && (
              <a
                href={row.xero_deep_link_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-un1t-white text-un1t-black text-xs font-medium hover:bg-un1t-accent"
              >
                Open in Xero ↗
              </a>
            )}
          </div>
        )}
        {!row.xero_bill_id && row.xero_email_message_id && (
          <div className="mt-1 text-xs text-green-300/80">
            (Legacy email forward — Message ID <code>{row.xero_email_message_id}</code>)
          </div>
        )}
      </div>
      <ReadOnlyFieldsSummary fields={f} />
    </div>
  )
}

function RejectedSummary({ row, busy, onDelete }) {
  return (
    <div className="space-y-3">
      <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded-lg p-3 text-sm">
        Rejected at {formatDateTime(row.rejected_at)} ({row.rejected_stage} stage). Reason: {row.reject_reason || '(no reason)'}
      </div>
      <button
        type="button"
        disabled={!!busy}
        onClick={onDelete}
        className="px-3 py-1.5 text-sm rounded-md border border-un1t-grey text-un1t-light disabled:opacity-50"
      >
        {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
      </button>
    </div>
  )
}

function ReadOnlyFieldsSummary({ fields }) {
  const rows = [
    ['Supplier',      fields.supplier_name],
    ['Invoice #',     fields.invoice_number],
    ['Invoice date',  fields.invoice_date],
    ['Due date',      fields.due_date],
    ['Currency',      fields.currency],
    ['Subtotal',      fields.subtotal],
    ['VAT / tax',     fields.tax_amount],
    ['Total',         fields.total],
    ['Category',      fields.category ? (CATEGORY_LABEL[fields.category] || fields.category) : null],
    ['Account code',  fields.account_code],
  ].filter(([, v]) => v != null && v !== '')
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-un1t-light">{k}</dt>
          <dd className="text-un1t-white text-right">{String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}
