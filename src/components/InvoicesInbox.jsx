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
//   • received / quality_approved → not read yet: "Being read", the reader's
//                         stop (duplicate, unreadable), or "Read now" + Reject.
//                         There is no quality approval step (INVSCREEN.2).
//   • extracted         → side-by-side: attachment preview + editable extracted-fields
//                         form + Approve / Reject buttons
//   • data_approved     → "Forwarding to Xero…" or retry button if forward failed
//   • forwarded         → read-only summary with Xero MessageID
//   • rejected          → read-only summary with reason + stage; Delete button
//   • not_invoice       → why, and "Move to Needs a look" (INVOICEPREP.3)
//
// INVOICEPREP.3 — rows are read and checked on arrival; review_reasons
// show as chips (see invoices/review-status.js).

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import InboundStraysNotice from '@/components/invoices/InboundStraysNotice'
import Link from 'next/link'
// BOOKKEEPER-APPROVALS.1 — read `?focus=<id>` so the drill-in from
// /approvals lands on the right row + correct tab.
import { useSearchParams } from 'next/navigation'
import { INVOICE_CATEGORIES } from '@/lib/invoice-categories'
import { hasResolvedVatRate } from '@/lib/invoices-queue/vat'
import XeroAccountPicker from '@/components/invoices/XeroAccountPicker'
import XeroTaxRatePicker from '@/components/invoices/XeroTaxRatePicker'
import XeroContactPicker from '@/components/invoices/XeroContactPicker'
import BulkUploadPanel from '@/components/invoices/BulkUploadPanel'
import { describeApiError } from '@/lib/api-error'
import {
  reasonChips, isReadyToSend, pillFor, notInvoiceText, unreadPanel, needsALookSkipped, isWaitingToBeRead,
  PILES, inPile, pileCounts,
  isBeingRead, canRejectOne,
} from '@/components/invoices/review-status'

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
// becomes a secondary filter via STATUS_FILTERS. "To do" (the
// default) means everything except sent + rejected, split into piles.
const SOURCE_TABS = [
  { key: 'all',                label: 'All',          sourceTypes: null },
  { key: 'supplier_email',     label: 'Supplier',     sourceTypes: ['supplier_email'] },
  { key: 'contractor_invoice', label: 'Contractor',   sourceTypes: ['contractor_invoice'] },
  { key: 'fte_expense_item',   label: 'Expenses',     sourceTypes: ['fte_expense_item'] },
  { key: 'card_receipt',       label: 'Card receipts',sourceTypes: ['card_receipt'] },
  { key: 'car_document',       label: 'Car documents',sourceTypes: ['car_document'] },
]

// INVSCREEN.2 — three views. "To do" also loads what the reader set aside as
// not an invoice, which shows as its own pile, so there is no separate filter.
const STATUS_FILTERS = [
  { key: 'pending',   label: 'To do',    statuses: ['received', 'quality_approved', 'extracted', 'data_approved', 'not_invoice'] },
  { key: 'forwarded', label: 'Sent',     statuses: ['forwarded'] },
  { key: 'rejected',  label: 'Rejected', statuses: ['rejected'] },
  { key: 'all',       label: 'All',      statuses: null },
]

// Human-friendly labels for bulk-action outcome keys in the summary.
const OUTCOME_LABEL = {
  ok: 'sent',
  extracted: 'extracted',
  linked: 'linked to Xero',
  already_in_xero: 'already in Xero',
  queued: 'queued',
  skipped: 'skipped',
  failed: 'failed',
  rejected: 'rejected',
}

const SOURCE_TYPE_LABEL = {
  supplier_email: 'Supplier email',
  contractor_invoice: 'Contractor invoice',
  fte_expense_item: 'Employee expense',
  card_receipt: 'Company-card receipt',
  car_document: 'Car document',
}

const SOURCE_TYPE_TONE = {
  supplier_email:     'bg-blue-500/20 text-blue-700 border-blue-500/40',
  contractor_invoice: 'bg-purple-500/20 text-purple-700 border-purple-500/40',
  fte_expense_item:   'bg-orange-500/20 text-orange-700 border-orange-500/40',
  card_receipt:       'bg-pink-500/20 text-pink-700 border-pink-500/40',
  car_document:       'bg-teal-500/20 text-teal-700 border-teal-500/40',
}

// INVOICES — order-insensitive comparison for the edit form's dirty
// check. extracted_fields is stored as jsonb, which normalises (re-
// orders) object keys on round-trip, so a plain JSON.stringify compare
// reports a saved row as still "dirty" and leaves Approve disabled.
// Canonicalise (recursively sort object keys; preserve array order)
// before comparing so only real value changes count as dirty.
function canonicaliseFields(v) {
  if (Array.isArray(v)) return v.map(canonicaliseFields)
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = canonicaliseFields(v[k]); return o }, {})
  }
  return v
}
function fieldsEqual(a, b) {
  return JSON.stringify(canonicaliseFields(a)) === JSON.stringify(canonicaliseFields(b))
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

// INVSCREEN.1 — the list route's own maximum. It used to be left at the
// default 100, which silently hid the oldest rows of a long queue.
const LIST_LIMIT = 500

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
  // INVSCREEN.1 — which pile of the To do list is shown.
  const [pile, setPile] = useState('review')
  // INVOICES-QUEUE.1 PR 2 — multi-select state for bulk actions.
  // Selection persists across tab switches (Set tracks ids; rows
  // not in the current filter just don't render their checkbox).
  const [bulkSelection, setBulkSelection] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(null)
  const [bulkError, setBulkError] = useState(null)
  const [bulkSummary, setBulkSummary] = useState(null)
  // INVOICEPREP.3 — "Open the earlier one": the earlier row, read by id, is
  // held here until the list contains it, so the selection never falls back
  // to the top row; missingEarlierId marks one that could not be found.
  const [pinnedRow, setPinnedRow] = useState(null)
  const pinnedIdRef = useRef(null)
  const [missingEarlierId, setMissingEarlierId] = useState(null)

  const activeStatuses = useMemo(
    () => STATUS_FILTERS.find((s) => s.key === statusFilter)?.statuses,
    [statusFilter],
  )
  const activeSourceTypes = useMemo(
    () => SOURCE_TABS.find((t) => t.key === sourceTab)?.sourceTypes,
    [sourceTab],
  )

  const loadRows = useCallback(async (opts = {}) => {
    if (!opts.silent) setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (activeStatuses) params.set('status', activeStatuses.join(','))
      if (activeSourceTypes) params.set('source_type', activeSourceTypes.join(','))
      // 'all' is sent as such: leaving it out means "the active studio only".
      params.set('location_id', locationFilter)
      params.set('limit', String(LIST_LIMIT))
      const res = await fetch(`/api/invoices-inbox?${params.toString()}`)
      const j = await res.json()
      if (!j.success) throw new Error(describeApiError(j, 'Failed to load'))
      setRows(j.data || [])
      setSelectedId((prev) => {
        // Prefer the URL-supplied focus on first load if it's in
        // the result set; otherwise keep the user's last pick if
        // still visible; otherwise default to the top row.
        const desired = prev || focusId
        if (desired && (j.data || []).some((r) => r.id === desired)) return desired
        if (desired && desired === pinnedIdRef.current) return desired
        // Default to the first row that is not a set-aside duplicate or unreadable file.
        const list = j.data || []
        return (list.find((r) => inPile(r, 'review')) || list[0])?.id || null
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

  const selected = rows.find((r) => r.id === selectedId)
    || (pinnedRow && pinnedRow.id === selectedId ? pinnedRow : null)

  // INVSCREEN.1 — the piles apply to To do only.
  const piled = statusFilter === 'pending'
  const counts = useMemo(() => pileCounts(rows), [rows])
  const visibleRows = useMemo(
    () => (piled ? rows.filter((r) => inPile(r, pile)) : rows),
    [rows, piled, pile],
  )
  // A row opened from elsewhere (a focus link, "Open the earlier one") may sit
  // in the other pile: show the pile that holds it.
  useEffect(() => {
    if (!piled) return
    const row = rows.find((r) => r.id === selectedId)
    if (row && !inPile(row, pile)) {
      setPile(inPile(row, 'not_invoice') ? 'not_invoice' : inPile(row, 'aside') ? 'aside' : 'review')
    }
  // Only a change of selection or of the loaded rows moves the pile.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rows, piled])
  function choosePile(next) {
    setPile(next)
    const first = rows.find((r) => inPile(r, next))
    if (first && !(selected && inPile(selected, next))) selectRow(first.id)
  }

  function selectRow(id) {
    pinnedIdRef.current = null
    setPinnedRow(null)
    setMissingEarlierId(null)
    setSelectedId(id)
  }

  // INVOICEPREP.3 — "Open the earlier one" on a possible duplicate. A row in
  // the loaded list is selected directly; otherwise it is read by id and the
  // filters are widened so the list can show it. If it cannot be read, the
  // current selection stays and the panel says so.
  async function openRow(id) {
    if (!id) return
    setMissingEarlierId(null)
    if (rows.some((r) => r.id === id)) { selectRow(id); return }
    const fromId = selectedId
    try {
      const res = await fetch(`/api/invoices-inbox/${id}`)
      const j = await res.json()
      if (!j?.success || !j.data) throw new Error('not found')
      pinnedIdRef.current = id
      setPinnedRow(j.data)
      setSelectedId(id)
      setStatusFilter('all')
      setSourceTab('all')
      setLocationFilter('all')
    } catch {
      setMissingEarlierId(fromId)
    }
  }

  // INVOICEPREP.3 — a restored row is back in To do; show it there.
  function onRestored(id) {
    setSelectedId(id)
    if (statusFilter === 'pending') loadRows()
    else setStatusFilter('pending')
  }

  // INV-BULK.3 — while any visible row is queued or mid-analysis,
  // poll silently every 5s so the operator watches the queue drain
  // (received/quality_approved → extracted) without manual refresh.
  // INVOICEPREP.3 — only rows still waiting to be read keep the poll going.
  const queueActive = useMemo(
    () => rows.some((r) => r.analysis_queued_at && ['received', 'quality_approved'].includes(r.status)),
    [rows],
  )
  useEffect(() => {
    if (!queueActive) return
    const t = setInterval(() => { loadRows({ silent: true }) }, 5000)
    return () => clearInterval(t)
  }, [queueActive, loadRows])

  // Tab counts — quick lookup so each tab's badge reflects pending
  // work without re-fetching per tab. We re-derive whenever rows
  // change. Caveat: the counts reflect what's CURRENTLY loaded
  // (post-filter on status + location). For the cross-tab counts
  // to be fully accurate would require a separate count endpoint;
  // for PR 2 the local count is "close enough" — the operator
  // clicks a tab to see the real list anyway.
  const sourceCounts = useMemo(() => {
    // Rows set aside as not an invoice are loaded with To do but are not work.
    const counted = rows.filter((r) => r.status !== 'not_invoice')
    const acc = { all: counted.length }
    for (const r of counted) acc[r.source_type] = (acc[r.source_type] || 0) + 1
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
    for (const r of visibleRows) next.add(r.id)
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
      if (!j.success) throw new Error(describeApiError(j, `Bulk ${action} failed`))
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

  // INVHARDEN.1 — "Extract selected" queues every chosen row for reading. It
  // used to read the first ten in the request itself, which could run past the
  // route's time limit on slow files and applied a different rule to those ten.
  // The queue reads within seconds and the list polls while it drains.
  async function extractSelected() {
    const ids = selectedRows
      .filter((r) => ['received', 'quality_approved'].includes(r.status) && !r.analysis_claimed_at)
      .map((r) => r.id)
    if (!ids.length) return
    setBulkBusy('extract')
    setBulkError(null)
    setBulkSummary(null)
    try {
      const res = await fetch('/api/invoices-inbox/bulk-queue-analysis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(describeApiError(j, 'Queue failed'))
      setBulkSummary({ action: 'Extract', counts: j.data?.counts || {} })
      setBulkSelection(new Set()) // clear so the same rows aren't re-sent
      await loadRows()
    } catch (e) {
      setBulkError(e.message)
    } finally {
      setBulkBusy(null)
    }
  }

  return (
    // INV-BULK.3 — reserve space at the bottom while the fixed bulk
    // action bar is shown, so it never covers the detail panel's lower
    // fields (e.g. the Xero supplier picker) and the page can scroll
    // everything clear of it.
    <div className={`space-y-6 ${isBookkeeper && bulkSelection.size > 0 ? 'pb-44' : ''}`}>
      <ForwardingAddresses locations={locations} />
      <BulkUploadPanel
        locations={locations}
        defaultLocationId={locationFilter !== 'all' ? locationFilter : (locations.length === 1 ? locations[0].id : null)}
        onUploaded={loadRows}
      />

      {/* Source-type tabs — primary navigation */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 border border-un1t-border rounded-lg p-1 bg-un1t-bg/40 flex-wrap">
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
                    ? 'bg-un1t-text text-un1t-bg font-medium'
                    : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {t.label}
                {count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full ${
                    isActive ? 'bg-un1t-bg text-un1t-text' : 'bg-un1t-border/40 text-un1t-subtle'
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
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          {locations.length > 1 && (
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text"
            >
              <option value="all">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {isMaster && <InboundStraysNotice />}

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-6">
        <InboxList
          rows={visibleRows}
          piles={piled ? { active: pile, counts, onChoose: choosePile } : null}
          capped={rows.length >= LIST_LIMIT}
          showLocation={locationFilter === 'all' && locations.length > 1}
          loading={loading}
          selectedId={selectedId}
          onSelect={selectRow}
          isBookkeeper={isBookkeeper}
          bulkSelection={bulkSelection}
          onToggleSelect={toggleSelection}
          onSelectAll={selectAllVisible}
          onClearSelection={clearSelection}
        />
        <InboxDetail
          row={selected}
          onChanged={loadRows}
          onOpenRow={openRow}
          onRestored={onRestored}
          earlierMissing={!!selectedId && missingEarlierId === selectedId}
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
          onExtract={extractSelected}
          onSend={() => runBulk('send', { ids: Array.from(bulkSelection) })}
          onMarkInXero={(ids) => runBulk('mark-in-xero', { ids })}
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
    <div className="border border-un1t-border rounded-lg p-4 bg-un1t-bg/40">
      <p className="text-xs uppercase tracking-wide text-un1t-subtle mb-2">Forwarding addresses</p>
      <ul className="space-y-1 text-sm">
        {locations.map((l) => (
          <li key={l.id} className="flex justify-between gap-3">
            <span className="text-un1t-text">{l.name}</span>
            {l.invoices_inbound_slug ? (
              <code className="text-un1t-subtle">{l.invoices_inbound_slug}-invoices@mail.un1tdublin.com</code>
            ) : (
              <Link href={`/settings/locations/${l.id}`} className="text-un1t-subtle underline">
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
  rows, loading, selectedId, onSelect, isBookkeeper,
  bulkSelection, onToggleSelect, onSelectAll, onClearSelection,
  piles = null, capped = false, showLocation = false,
}) {
  const allVisibleSelected = rows.length > 0 && rows.every((r) => bulkSelection.has(r.id))
  // INV-BULK.3 — live queue progress across the visible list.
  const queueProgress = rows.reduce(
    (acc, r) => {
      if (!r.analysis_queued_at) return acc
      acc.total++
      if (r.analysis_claimed_at) acc.analysing++
      else acc.queued++
      return acc
    },
    { total: 0, queued: 0, analysing: 0 },
  )
  return (
    // INVLIST.1 — beside the detail panel (lg and up) the list fills the panel's
    // full height and scrolls inside it. It used to stop at 70% of the screen
    // height while its box stretched to the taller detail panel, leaving a
    // blank half that looked like a list that had not finished loading. The
    // inner wrapper is absolutely placed so the list's own length never sets
    // the row height; the detail panel does, with a floor for a short one.
    <aside className="border border-un1t-border rounded-lg overflow-hidden min-w-0 lg:relative lg:min-h-[70vh]">
      <div className="flex flex-col lg:absolute lg:inset-0">
      {piles && (
        <div className="px-2 py-2 border-b border-un1t-border flex items-center gap-1 flex-wrap">
          {PILES.map((p) => {
            const on = piles.active === p.key
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={on}
                onClick={() => piles.onChoose(p.key)}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  on ? 'bg-un1t-text text-un1t-bg font-medium' : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {p.label} <span className="tabular-nums">{piles.counts[p.key]}</span>
              </button>
            )
          })}
        </div>
      )}
      <header className="px-3 py-2 border-b border-un1t-border flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-un1t-subtle">
          {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
          {queueProgress.total > 0 && (
            <span className="ml-2 normal-case tracking-normal text-un1t-text">
              · {queueProgress.analysing > 0 ? `${queueProgress.analysing} analysing, ` : ''}
              {queueProgress.queued} queued
            </span>
          )}
        </span>
        {isBookkeeper && rows.length > 0 && (
          <button
            type="button"
            onClick={allVisibleSelected ? onClearSelection : onSelectAll}
            className="text-xs text-un1t-subtle hover:text-un1t-text underline underline-offset-2"
          >
            {allVisibleSelected ? 'Clear selection' : 'Select all'}
          </button>
        )}
      </header>
      <ul className="divide-y divide-un1t-border/50 max-h-[70vh] overflow-y-auto lg:max-h-none lg:flex-1 lg:min-h-0">
        {rows.length === 0 && !loading && (
          <li className="p-4 text-sm text-un1t-subtle">Nothing here.</li>
        )}
        {capped && !loading && (
          <li className="px-3 py-2 text-xs text-amber-700 bg-amber-500/10">
            Showing the newest {LIST_LIMIT}. Older ones appear as these are cleared, or pick one studio.
          </li>
        )}
        {rows.map((r) => {
          const active = r.id === selectedId
          const checked = bulkSelection.has(r.id)
          return (
            <li key={r.id} className={checked ? 'bg-un1t-text/10' : ''}>
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
                      className="h-4 w-4 accent-un1t-text"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(r.id)}
                  className={`flex-1 min-w-0 text-left p-3 transition-colors ${
                    active ? 'bg-un1t-text/10' : 'hover:bg-un1t-text/5'
                  }`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="text-sm font-medium text-un1t-text truncate min-w-0">
                      {r.extracted_fields?.supplier_name || r.sender_email || '(no sender)'}
                    </div>
                    {/* The chips say what the row needs; the stage pill is kept
                        only for a row that has none, so the chips are never cut off. */}
                    <span className="flex items-center gap-1 flex-wrap justify-end shrink-0 max-w-[60%]">
                      <ReasonChips row={r} compact />
                      {reasonChips(r).length === 0 && (
                        <StatusPill status={r.status} stage={r.rejected_stage} queuedAt={r.analysis_queued_at} claimedAt={r.analysis_claimed_at} />
                      )}
                    </span>
                  </div>
                  <div className="text-xs text-un1t-subtle truncate mt-1">
                    {r.subject || r.attachment_filename || '(no subject)'}
                  </div>
                  <div className="text-xs text-un1t-subtle mt-1 flex justify-between items-center gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <SourceTypePill source={r.source_type} />
                      <span className="truncate">{formatDateTime(r.received_at)}</span>
                    </span>
                    {showLocation && <span className="shrink-0">{r.location?.name}</span>}
                  </div>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      </div>
    </aside>
  )
}

function SourceTypePill({ source }) {
  const label = SOURCE_TYPE_LABEL[source] || source
  const tone = SOURCE_TYPE_TONE[source] || 'bg-un1t-border/30 text-un1t-subtle border-un1t-border'
  return (
    <span className={`text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 whitespace-nowrap ${tone}`}>
      {label}
    </span>
  )
}

function BulkActionBar({
  selectedCount, selectedRows, busy, error, summary,
  onExtract, onSend, onMarkInXero, onReject, onClear,
}) {
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  // Per-action eligibility — the backend skips bad rows anyway, but
  // disabling the buttons when zero selected rows match the action's
  // legal states is friendlier UX.
  // Queueable for background analysis: 'received' (the operator's
  // selection vouches for quality) and 'quality_approved' not
  // already in flight. Re-queuing a row that previously errored is
  // allowed — the cron cleared its queue flags on failure.
  const queueableCount = selectedRows.filter((r) =>
    ['received', 'quality_approved'].includes(r.status) && !r.analysis_claimed_at).length
  // XERO-BILL-VAT.2 — a row is only sendable once its VAT rate is resolved
  // (confirmed tax_type or a genuine 0%-VAT bill); rate-undetermined rows
  // are skipped server-side, so don't count them toward the Send button.
  const sendableCount = selectedRows.filter((r) =>
    ['extracted', 'data_approved'].includes(r.status) && r.extracted_fields && hasResolvedVatRate(r.extracted_fields)
    // INVOICEPREP.3 — and nothing flagged; the send skips a row that needs a look.
    && isReadyToSend(r)).length
  const rejectableCount = selectedRows.filter((r) =>
    ['received', 'quality_approved', 'extracted', 'data_approved'].includes(r.status)).length
  // INV-RECONCILE.1 — ONLY rows the send path flagged as already in
  // Xero (xero_error carries the 'Already in Xero' message). This is the
  // duplicate set to reconcile — NOT every selected row, so the button
  // can't sweep genuine failures (missing account/supplier) into the
  // 'in Xero' state. The endpoint re-verifies each against Xero anyway.
  const markableRows = selectedRows.filter((r) =>
    ['extracted', 'data_approved'].includes(r.status) &&
    r.extracted_fields &&
    /already in xero/i.test(r.xero_error || ''))
  const markableCount = markableRows.length

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-un1t-border bg-un1t-bg/95 backdrop-blur p-4 max-h-[60vh] overflow-y-auto">
      <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap">
        <span className="text-sm text-un1t-text font-medium">
          {selectedCount} selected
        </span>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <button
            type="button"
            disabled={queueableCount === 0 || !!busy}
            onClick={onExtract}
            className="px-3 py-1.5 text-sm rounded-md border border-un1t-border text-un1t-text disabled:opacity-40"
            title={queueableCount === 0 ? 'No selected rows are eligible for extraction' : 'Queues the selected rows to be read; each appears as it is read'}
          >
            {busy === 'extract' ? 'Extracting…' : `Extract selected (${queueableCount})`}
          </button>
          <button
            type="button"
            disabled={sendableCount === 0 || !!busy}
            onClick={onSend}
            className="px-3 py-1.5 text-sm rounded-md bg-un1t-text text-un1t-bg font-medium disabled:opacity-40"
            title={sendableCount === 0 ? 'No selected rows are ready to send' : ''}
          >
            {busy === 'send' ? 'Sending…' : `Send to Xero (${sendableCount})`}
          </button>
          <button
            type="button"
            disabled={markableCount === 0 || !!busy}
            onClick={() => onMarkInXero(markableRows.map((r) => r.id))}
            className="px-3 py-1.5 text-sm rounded-md border border-un1t-border text-un1t-subtle disabled:opacity-40"
            title={markableCount === 0 ? 'Only rows flagged “already in Xero” (after a send attempt) can be reconciled here' : 'Links each invoice already in Xero to its existing bill and clears it from the queue. Never creates a duplicate.'}
          >
            {busy === 'mark-in-xero' ? 'Reconciling…' : `Mark as in Xero (${markableCount})`}
          </button>
          <button
            type="button"
            disabled={rejectableCount === 0 || !!busy}
            onClick={() => setShowRejectForm((v) => !v)}
            className="px-3 py-1.5 text-sm rounded-md border border-un1t-border text-un1t-subtle disabled:opacity-40"
          >
            Reject ({rejectableCount})…
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-1.5 text-sm rounded-md text-un1t-subtle hover:text-un1t-text"
          >
            Clear
          </button>
        </div>
      </div>

      {showRejectForm && (
        <div className="max-w-7xl mx-auto mt-3 space-y-2 border border-un1t-border rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-subtle">Reject reason (applied to all selected)</label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md p-2 text-sm text-un1t-text"
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
        <div className="max-w-7xl mx-auto mt-3 border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-2 text-xs">
          {error}
        </div>
      )}
      {summary && (
        <div className="max-w-7xl mx-auto mt-3 border border-un1t-border rounded-lg p-2 text-xs text-un1t-subtle flex flex-wrap gap-3">
          <strong className="text-un1t-text">{summary.action} result:</strong>
          {Object.entries(summary.counts || {}).map(([k, v]) => (
            <span key={k}>{OUTCOME_LABEL[k] || k}: <strong className="text-un1t-text">{v}</strong></span>
          ))}
          {needsALookSkipped(summary.results) > 0 && (
            <span>skipped, needs a look: <strong className="text-un1t-text">{needsALookSkipped(summary.results)}</strong></span>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status, stage, queuedAt = null, claimedAt = null }) {
  // INV-BULK.3 — a row queued for background analysis sits in
  // 'quality_approved'; surface the live sub-state instead of the
  // static label so the operator sees it move through the queue.
  // INVOICEPREP.3 — every queued row reads "Reading…"; a claimed one
  // (being read right now) keeps its pulse.
  const extra = pillFor({ status, analysis_queued_at: queuedAt })
  if (extra?.tone === 'blue') {
    return claimedAt
      ? <span className="text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap bg-blue-500/20 text-blue-700 border-blue-500/40 animate-pulse">{extra.label}</span>
      : <span className="text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap bg-blue-500/20 text-blue-700 border-blue-500/40">{extra.label}</span>
  }
  if (extra) {
    return (
      <span className="text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap bg-un1t-border/30 text-un1t-subtle border-un1t-border">
        {extra.label}
      </span>
    )
  }
  const map = {
    received:         { label: 'Awaiting review',  cls: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
    quality_approved: { label: 'Awaiting extract', cls: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
    extracted:        { label: 'Awaiting data',    cls: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
    data_approved:    { label: 'Awaiting send',    cls: 'bg-purple-500/20 text-purple-700 border-purple-500/40' },
    forwarded:        { label: 'Sent to Xero',     cls: 'bg-green-500/20 text-green-700 border-green-500/40' },
    rejected:         { label: `Rejected (${stage || 'quality'})`, cls: 'bg-red-500/20 text-red-700 border-red-500/40' },
  }
  const it = map[status] || { label: status, cls: 'bg-un1t-border/30 text-un1t-subtle border-un1t-border' }
  return (
    <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 whitespace-nowrap ${it.cls}`}>
      {it.label}
    </span>
  )
}

// INVOICEPREP.3 — why a row needs a look, or a green Ready.
const CHIP_TONE = {
  red: 'bg-red-500/10 text-red-700',
  amber: 'bg-amber-500/10 text-amber-700',
  green: 'bg-green-500/10 text-green-700',
}
function ReasonChips({ row, compact = false }) {
  const chips = reasonChips(row)
  if (chips.length === 0) return null
  const size = compact ? 'text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap' : 'text-xs px-2 py-1 rounded'
  return chips.map((c) => (
    <span key={c.key} className={`${size} ${CHIP_TONE[c.tone]}`}>{c.label}</span>
  ))
}

function InboxDetail({ row, onChanged, onOpenRow, onRestored, earlierMissing = false }) {
  const [attachment, setAttachment] = useState(null)
  const [attLoading, setAttLoading] = useState(false)
  const [busy, setBusy] = useState(null) // 'approve' | 'reject' | 'extract' | 'send' | 'delete'
  const [actionError, setActionError] = useState(null)
  // The email text is not on the list row (it can be long); read it by id when
  // an emailed row opens. Kept with its row id so one row's text never shows
  // under another while the next fetch is in flight.
  const [body, setBody] = useState({ id: null, text: null })
  const isEmailed = row?.source_type === 'supplier_email'

  useEffect(() => {
    if (!row?.id || !isEmailed) return
    const id = row.id
    let cancelled = false
    fetch(`/api/invoices-inbox/${id}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.success) setBody({ id, text: j.data?.email_body_text || null }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [row?.id, isEmailed])
  const bodyText = isEmailed && body.id === row?.id ? body.text : null

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
      <section className="border border-un1t-border rounded-lg p-6 text-sm text-un1t-subtle min-h-[200px] flex items-center justify-center">
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
      if (!j.success) {
        // INVOICEPREP.3 — a read that failed (422) still saved its error
        // on the row; reload so the panel shows it.
        // A 409 on restore means the row moved on; reload to show where.
        if (res.status === 422 || (path === 'restore' && res.status === 409)) onChanged()
        throw new Error(describeApiError(j, 'Action failed'))
      }
      if (path === 'restore' && onRestored) onRestored(row.id)
      else onChanged()
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
      // EMPTY-STRING-FIELDS.1 — validateBody answers a schema failure with a
      // generic `error` ("Invalid request body") plus an `issues` array naming
      // the field. Showing only the generic half told the operator nothing —
      // the real message ("invoice_date must be YYYY-MM-DD") was in the
      // response the whole time, and the receipt looked broken rather than
      // one box wrong.
      if (!j.success) throw new Error(describeApiError(j, 'Save failed'))
      onChanged()
      // Return the server's canonical stored fields so the editor can
      // resync — keeps the dirty check accurate after any normalisation.
      return j.data?.extracted_fields || extracted_fields
    } catch (e) {
      setActionError(e.message)
      return null
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
      if (!j.success) throw new Error(describeApiError(j, 'Delete failed'))
      onChanged()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border border-un1t-border rounded-lg p-5 space-y-5">
      <DetailHeader row={row} />
      <ArrivalNotes row={row} bodyText={bodyText} />

      {actionError && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm">
          {actionError}
        </div>
      )}

      <AttachmentPreview attachment={attachment} loading={attLoading} mime={row.attachment_mime_type} />

      <DuplicatePointer row={row} onOpenRow={onOpenRow} missing={earlierMissing} />

      {row.status === 'not_invoice' && (
        <NotInvoiceActions
          row={row}
          busy={busy}
          onRestore={() => postAction('restore')}
        />
      )}

      {/* INVSCREEN.2 — one panel for every row that has not been read: being
          read, stopped by the reader, or waiting. No quality approval step. */}
      {(row.status === 'received' || row.status === 'quality_approved') && (
        <StageOneActions
          busy={busy}
          panel={unreadPanel(row)}
          reading={isBeingRead(row)}
          waiting={isWaitingToBeRead(row)}
          extractionError={row.extraction_error}
          onReadAgain={() => postAction('extract')}
          onReject={canRejectOne(row) ? (reason) => postAction('quality-reject', { reason }) : null}
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

function notInvoiceLine(reason) {
  const read = notInvoiceText(reason)
  if (read) return read
  if (reason === 'no_attachment') return 'Nothing usable was attached'
  if (reason === 'attachment_not_received: too_large') return 'An attachment was too large to receive (over 25 MB)'
  if (reason === 'attachment_not_received: too_many') return 'An attachment was not received (more than 25 files in one email)'
  if (reason?.startsWith('attachment_not_received:')) return 'An attachment could not be received'
  if (reason?.startsWith('unsupported_type:')) return `The attachment type is not supported (${reason.slice('unsupported_type:'.length).trim()})`
  return null
}

// INVOICEPREP.1 — why an email had nothing usable, and the email's own text.
function ArrivalNotes({ row, bodyText }) {
  const line = notInvoiceLine(row.not_invoice_reason)
  const skipped = row.skipped_attachment_count || 0
  if (!line && !skipped && !bodyText) return null
  return (
    <div className="space-y-2 text-sm">
      {line && (
        <p className="text-un1t-text break-words">
          {line}
          {row.not_invoice_reason?.startsWith('attachment_not_received:') && row.attachment_filename ? ` — ${row.attachment_filename}` : ''}
        </p>
      )}
      {skipped > 0 && (
        <p className="text-xs text-un1t-subtle">{skipped === 1 ? '1 email image skipped' : `${skipped} email images skipped`}</p>
      )}
      {bodyText && (
        <details className="border border-un1t-border rounded-lg">
          <summary className="cursor-pointer px-3 py-2 text-xs text-un1t-subtle">Email text</summary>
          <div className="px-3 pb-3 whitespace-pre-wrap break-words text-un1t-text">{bodyText}</div>
        </details>
      )}
    </div>
  )
}

function DetailHeader({ row }) {
  return (
    <header className="space-y-1">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-un1t-text">
          {row.extracted_fields?.supplier_name || row.sender_email || '(no sender)'}
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {row.xero_tax_mismatch === true ? (
            // audit F2 (RCOV.P2) — Xero booked a different tax figure
            // than the OCR read off the receipt (account default VAT
            // rate likely wrong for this supplier).
            <span
              className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-700"
              title={`Xero booked €${row.xero_total_tax} tax; the receipt shows €${row.extracted_fields?.tax_amount}. Check the account's default VAT rate in Xero.`}
            >
              VAT mismatch
            </span>
          ) : null}
          <ReasonChips row={row} />
          <StatusPill status={row.status} stage={row.rejected_stage} queuedAt={row.analysis_queued_at} claimedAt={row.analysis_claimed_at} />
        </div>
      </div>
      <p className="text-sm text-un1t-subtle">{row.subject || '(no subject)'}</p>
      <p className="text-xs text-un1t-subtle">
        Received {formatDateTime(row.received_at)} · {row.location?.name || 'unknown location'} · {formatBytes(row.attachment_size_bytes)}
      </p>
    </header>
  )
}

function AttachmentPreview({ attachment, loading, mime }) {
  if (loading) {
    return <div className="border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle">Loading attachment…</div>
  }
  if (!attachment) {
    return <div className="border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle">No attachment available.</div>
  }
  const isPdf = mime === 'application/pdf'
  return (
    <div className="border border-un1t-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-un1t-border flex justify-between items-center text-xs">
        <span className="text-un1t-subtle truncate">{attachment.filename}</span>
        <a href={attachment.url} target="_blank" rel="noreferrer" className="text-un1t-text underline">
          Open in new tab
        </a>
      </div>
      {isPdf ? (
        <iframe
          title="Invoice attachment"
          src={attachment.url}
          className="w-full bg-un1t-bg"
          style={{ height: '60vh' }}
        />
      ) : (
        <img src={attachment.url} alt="Invoice attachment" className="w-full max-h-[60vh] object-contain bg-un1t-bg" />
      )}
    </div>
  )
}

// INVOICEPREP.3 — `panel` (from unreadPanel) retitles this for a row the
// reader gave up on; without it, today's quality review shows unchanged.
// `reading` (a row queued to be read) shows only a short line and Reject.
function StageOneActions({ busy, panel = null, reading = false, waiting = false, extractionError = null, onReadAgain, onReject }) {
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [reason, setReason] = useState('')
  const primaryCls = 'px-4 py-2 rounded-md bg-un1t-text text-un1t-bg font-medium disabled:opacity-50'
  const secondaryCls = 'px-4 py-2 rounded-md border border-un1t-border text-un1t-text disabled:opacity-50'
  const readButton = (cls) => (
    <button key="read" type="button" disabled={!!busy} onClick={onReadAgain} className={cls}>
      {busy === 'extract' ? 'Reading…' : (!panel ? 'Read now' : panel.primary === 'read_again' ? 'Read again' : 'Read it anyway')}
    </button>
  )
  const rejectButton = (cls) => (
    <button key="reject" type="button" disabled={!!busy} onClick={() => setShowRejectForm((v) => !v)} className={cls}>
      Reject…
    </button>
  )
  return (
    <div className="space-y-3">
      {reading ? (
        <>
          <p className="text-sm text-un1t-subtle">Being read. This takes a moment.</p>
          {onReject && <div className="flex gap-2 flex-wrap">{rejectButton(secondaryCls)}</div>}
        </>
      ) : panel ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-un1t-text">{panel.title}</p>
          {extractionError && <p className="text-xs text-un1t-subtle break-words">{extractionError}</p>}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm text-un1t-subtle">
            {waiting ? 'Waiting to be read. It is picked up automatically within a few minutes, or read it now.' : 'This has not been read yet.'}
          </p>
          {extractionError && <p className="text-xs text-un1t-subtle break-words">{extractionError}</p>}
        </div>
      )}
      {reading ? null : panel ? (
        <div className="flex gap-2 flex-wrap">
          {/* onReject is null when quality-reject would refuse the row
              (canRejectOne); the read is then offered alone. */}
          {!onReject
            ? readButton(primaryCls)
            : panel.primary === 'reject'
              ? [rejectButton(primaryCls), readButton(secondaryCls)]
              : [readButton(primaryCls), rejectButton(secondaryCls)]}
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          {readButton(primaryCls)}
          {onReject && rejectButton(secondaryCls)}
        </div>
      )}
      {showRejectForm && onReject && (
        <div className="space-y-2 border border-un1t-border rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-subtle">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md p-2 text-sm text-un1t-text"
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

// INVOICEPREP.3 — a row the reader judged not to be an invoice. The reason
// line shows in ArrivalNotes; this offers the way back.
function NotInvoiceActions({ row, busy, onRestore }) {
  if (!row.attachment_path) {
    return <p className="text-sm text-un1t-subtle">There is no attachment to read</p>
  }
  return (
    <div className="flex gap-2 flex-wrap">
      <button
        type="button"
        disabled={!!busy}
        onClick={onRestore}
        className="px-4 py-2 rounded-md bg-un1t-text text-un1t-bg font-medium disabled:opacity-50"
      >
        {busy === 'restore' ? 'Moving…' : 'Move to Needs a look'}
      </button>
    </div>
  )
}

// INVOICEPREP.3 — points a possible duplicate at the earlier row.
function DuplicatePointer({ row, onOpenRow, missing = false }) {
  const reasons = Array.isArray(row.review_reasons) ? row.review_reasons : []
  if (!row.duplicate_of_id) return null
  if (!reasons.includes('duplicate_file') && !reasons.includes('duplicate_number')) return null
  return (
    <div className="flex items-center gap-3 flex-wrap text-sm">
      <span className="text-un1t-text">Possible duplicate of an earlier invoice</span>
      <button
        type="button"
        onClick={() => onOpenRow?.(row.duplicate_of_id)}
        className="text-un1t-text underline underline-offset-2"
      >
        Open the earlier one
      </button>
      {missing && <span className="text-un1t-subtle">The earlier invoice is no longer in the list.</span>}
    </div>
  )
}

function StageTwoBlock({ row, busy, onSaveFields, onApprove, onReject }) {
  const initial = row.extracted_fields || {}
  const [fields, setFields] = useState(initial)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [reason, setReason] = useState('')
  const dirty = !fieldsEqual(fields, initial)
  // Reset the edit form only when a DIFFERENT row is selected — never
  // on a background refresh. INV-BULK.3's queue polling replaces the
  // rows array (new extracted_fields object refs) every 5s while a
  // batch drains; keying this on row.extracted_fields wiped the
  // operator's in-progress edits (e.g. a half-picked Xero supplier)
  // mid-review, so saves appeared not to stick. row.id is the
  // identity that should reset the form.
  useEffect(() => {
    setFields(row.extracted_fields || {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id])

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
      <p className="text-sm text-un1t-subtle">
        Data review — confirm the extracted fields. Edit anything that's wrong. Approving sends the original attachment to Xero's bills email; Xero creates a draft bill from it.
      </p>

      {row.xero_error && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm">
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
        {/* XERO-BILL-VAT.2 — VAT-rate picker. Defaults to the rate
            derived from the bill, matched against the location's real
            Xero tax rates; the bookkeeper confirms or overrides. The
            chosen TaxType is sent on every LineItem at push. */}
        <XeroTaxRatePicker
          locationId={row.location_id}
          fields={fields}
          value={strField('tax_type') || null}
          onChange={(taxType, source) => {
            setField('tax_type', taxType)
            setField('tax_type_source', taxType ? source : null)
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
          // A 'data_approved' row whose Xero send FAILED (xero_error
          // set, never forwarded) is re-opened for correction, so the
          // operator can fix the field that broke the send and retry.
          // Successfully forwarded rows stay frozen (isApproved without
          // an error is the post-send state and never reaches here).
          disabled={!dirty || !!busy || (isApproved && !row.xero_error)}
          onClick={async () => { const saved = await onSaveFields(fields); if (saved) setFields(saved) }}
          className="px-4 py-2 rounded-md border border-un1t-border text-un1t-text disabled:opacity-50"
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
          const title = gate
            ? `Pick a ${missing.join(' + ')} before sending`
            : (dirty ? 'Saves your edits, then sends to Xero' : '')
          // Auto-save any unsaved edits before sending. The data-approve
          // route reads extracted_fields from the DB, so we must persist
          // first — doing it here means the operator picks supplier +
          // account and clicks one button instead of Save-then-Approve.
          const approve = async () => {
            if (dirty) {
              const saved = await onSaveFields(fields)
              if (!saved) return   // save failed — error already surfaced
              setFields(saved)
            }
            onApprove()
          }
          return (
            <>
              <button
                type="button"
                disabled={!!busy || gate}
                onClick={approve}
                className="px-4 py-2 rounded-md bg-un1t-text text-un1t-bg font-medium disabled:opacity-50"
                title={title}
              >
                {busy === 'data-approve' ? (isApproved ? 'Retrying send…' : 'Approving + sending…') : (isApproved ? 'Retry send to Xero' : 'Approve + send to Xero')}
              </button>
              {/* NEWSUPPLIER.1 — the reason the button is off used to be a
                  hover tooltip only, so a greyed button looked broken. */}
              {gate && (
                <span role="status" className="order-last basis-full text-sm text-amber-700">
                  {title}.
                </span>
              )}
            </>
          )
        })()}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowRejectForm((v) => !v)}
          className="px-4 py-2 rounded-md border border-un1t-border text-un1t-text disabled:opacity-50"
        >
          Reject…
        </button>
      </div>
      {showRejectForm && (
        <div className="space-y-2 border border-un1t-border rounded-md p-3">
          <label className="text-xs uppercase tracking-wide text-un1t-subtle">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md p-2 text-sm text-un1t-text"
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
      <span className="text-xs uppercase tracking-wide text-un1t-subtle">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
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
      <span className="text-xs uppercase tracking-wide text-un1t-subtle">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// XERO-WEBHOOK.1 — Xero invoice Status → friendly label for the
// payment line shown on a forwarded bill.
const XERO_STATUS_LABEL = {
  DRAFT: 'Draft in Xero',
  SUBMITTED: 'Submitted for approval',
  AUTHORISED: 'Awaiting payment',
  PAID: 'Paid',
  VOIDED: 'Voided',
  DELETED: 'Deleted',
}

function ForwardedSummary({ row }) {
  const f = row.extracted_fields || {}
  // XERO-API.3 — new rows have xero_bill_id + xero_deep_link_url.
  // Historical rows (forwarded via the old Postmark/Hubdoc path)
  // only have xero_email_message_id — render whichever is present.
  return (
    <div className="space-y-3">
      <div className="border border-green-500/40 bg-green-500/10 text-green-700 rounded-lg p-3 text-sm">
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
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-un1t-text text-un1t-bg text-xs font-medium hover:bg-un1t-accent"
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

      {/* XERO-WEBHOOK.1 — payment status synced back from Xero. The
          Invoices webhook flips this to PAID when the bookkeeper
          reconciles the bill; blank until the first webhook event. */}
      {row.xero_bill_status === 'PAID' ? (
        <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 rounded-lg p-3 text-sm">
          Paid in Xero
          {row.xero_bill_paid_at
            && ` · ${new Date(row.xero_bill_paid_at).toLocaleDateString('en-IE')}`}
          {row.xero_bill_amount_paid != null
            && ` · ${f.currency || 'EUR'} ${Number(row.xero_bill_amount_paid).toFixed(2)}`}
        </div>
      ) : row.xero_bill_status ? (
        <div className="text-xs text-un1t-subtle px-1">
          Xero status:{' '}
          <span className="text-un1t-text">
            {XERO_STATUS_LABEL[row.xero_bill_status] || row.xero_bill_status}
          </span>
          {row.xero_bill_amount_due != null && Number(row.xero_bill_amount_due) > 0
            && ` · ${f.currency || 'EUR'} ${Number(row.xero_bill_amount_due).toFixed(2)} due`}
        </div>
      ) : null}

      <ReadOnlyFieldsSummary fields={f} />
    </div>
  )
}

function RejectedSummary({ row, busy, onDelete }) {
  return (
    <div className="space-y-3">
      <div className="border border-red-500/40 bg-red-500/10 text-red-700 rounded-lg p-3 text-sm">
        Rejected at {formatDateTime(row.rejected_at)} ({row.rejected_stage} stage). Reason: {row.reject_reason || '(no reason)'}
      </div>
      <button
        type="button"
        disabled={!!busy}
        onClick={onDelete}
        className="px-3 py-1.5 text-sm rounded-md border border-un1t-border text-un1t-subtle disabled:opacity-50"
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
          <dt className="text-un1t-subtle">{k}</dt>
          <dd className="text-un1t-text text-right">{String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}
