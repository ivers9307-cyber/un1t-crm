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

const TAB_DEFS = [
  { key: 'quality',   label: 'Quality review', statuses: ['received'] },
  { key: 'data',      label: 'Data review',    statuses: ['quality_approved', 'extracted', 'data_approved'] },
  { key: 'forwarded', label: 'Forwarded',      statuses: ['forwarded'] },
  { key: 'rejected',  label: 'Rejected',       statuses: ['rejected'] },
]

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

export default function InvoicesInbox({ locations, isMaster }) {
  const [tab, setTab] = useState('quality')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [locationFilter, setLocationFilter] = useState('all')

  const activeStatuses = useMemo(
    () => TAB_DEFS.find((t) => t.key === tab)?.statuses || [],
    [tab],
  )

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('status', activeStatuses.join(','))
      if (locationFilter !== 'all') params.set('location_id', locationFilter)
      const res = await fetch(`/api/invoices-inbox?${params.toString()}`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to load')
      setRows(j.data || [])
      // Preserve selection if still present; otherwise auto-select first row.
      setSelectedId((prev) => {
        if (prev && (j.data || []).some((r) => r.id === prev)) return prev
        return (j.data || [])[0]?.id || null
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [activeStatuses, locationFilter])

  useEffect(() => { loadRows() }, [loadRows])

  const selected = rows.find((r) => r.id === selectedId) || null

  return (
    <div className="space-y-6">
      <ForwardingAddresses locations={locations} />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 border border-un1t-grey rounded-lg p-1 bg-un1t-black/40">
          {TAB_DEFS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                tab === t.key
                  ? 'bg-un1t-white text-un1t-black font-medium'
                  : 'text-un1t-light hover:text-un1t-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
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
        />
        <InboxDetail
          row={selected}
          onChanged={loadRows}
          isMaster={isMaster}
        />
      </div>
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
              <code className="text-un1t-light">{l.invoices_inbound_slug}-invoices@un1tdublin.com</code>
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

function InboxList({ rows, loading, selectedId, onSelect, isMaster }) {
  return (
    <aside className="border border-un1t-grey rounded-lg overflow-hidden">
      <header className="px-3 py-2 border-b border-un1t-grey text-xs uppercase tracking-wide text-un1t-light">
        {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
      </header>
      <ul className="divide-y divide-un1t-grey/50 max-h-[70vh] overflow-y-auto">
        {rows.length === 0 && !loading && (
          <li className="p-4 text-sm text-un1t-light">Nothing here.</li>
        )}
        {rows.map((r) => {
          const active = r.id === selectedId
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                className={`w-full text-left p-3 transition-colors ${
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
                <div className="text-xs text-un1t-light mt-1 flex justify-between">
                  <span>{formatDateTime(r.received_at)}</span>
                  {isMaster && <span>{r.location?.name}</span>}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
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
        <FieldRow label="Supplier"     value={strField('supplier_name')}   onChange={(v) => setField('supplier_name', v)} />
        <FieldRow label="Invoice #"    value={strField('invoice_number')}  onChange={(v) => setField('invoice_number', v)} />
        <FieldRow label="Invoice date" value={strField('invoice_date')}    onChange={(v) => setField('invoice_date', v)} placeholder="YYYY-MM-DD" />
        <FieldRow label="Due date"     value={strField('due_date')}        onChange={(v) => setField('due_date', v)} placeholder="YYYY-MM-DD" />
        <FieldRow label="Currency"     value={strField('currency')}        onChange={(v) => setField('currency', v.toUpperCase())} />
        <FieldRow label="Subtotal"     value={numField('subtotal')}        onChange={(v) => setField('subtotal', v === '' ? null : Number(v))} type="number" />
        <FieldRow label="VAT / tax"    value={numField('tax_amount')}      onChange={(v) => setField('tax_amount', v === '' ? null : Number(v))} type="number" />
        <FieldRow label="Total"        value={numField('total')}           onChange={(v) => setField('total', v === '' ? null : Number(v))} type="number" />
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
        <button
          type="button"
          disabled={dirty || !!busy}
          onClick={onApprove}
          className="px-4 py-2 rounded-md bg-un1t-white text-un1t-black font-medium disabled:opacity-50"
          title={dirty ? 'Save edits before approving' : ''}
        >
          {busy === 'data-approve' ? (isApproved ? 'Retrying send…' : 'Approving + sending…') : (isApproved ? 'Retry send to Xero' : 'Approve + send to Xero')}
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

function ForwardedSummary({ row }) {
  const f = row.extracted_fields || {}
  return (
    <div className="space-y-3">
      <div className="border border-green-500/40 bg-green-500/10 text-green-300 rounded-lg p-3 text-sm">
        Forwarded to Xero at {formatDateTime(row.forwarded_at)}.
        {row.xero_email_message_id && <> Message ID <code className="text-xs">{row.xero_email_message_id}</code>.</>}
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
