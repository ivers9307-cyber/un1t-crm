// RCOV.P2 — the Exceptions tab: the 2026-07-03 receipt-pipeline audit
// findings as live sections (F2 VAT mismatches, F3 aging drafts,
// F5 doc-less bills, F4 receiptless-expected) plus stuck queue rows.
// Sections render only when non-empty; a clean pipeline shows one
// empty state.
'use client'

import { useEffect, useState } from 'react'
import { Card, EmptyState, Loading } from '@/components/ui'

const eur = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0)

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IE') : '—')

function XeroLink({ url }) {
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
      Open in Xero
    </a>
  )
}

function Section({ title, tone, intro, rows, columns }) {
  if (!rows || rows.length === 0) return null
  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <h3 className={`text-sm font-semibold ${tone}`}>{title}</h3>
        <span className="text-xs px-2 py-0.5 rounded bg-gray-500/10 text-gray-700">{rows.length}</span>
      </div>
      {intro ? <p className="text-xs text-un1t-subtle mb-3">{intro}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-un1t-subtle border-b border-un1t-border">
              {columns.map((c) => (
                <th key={c.label} className="py-1.5 pr-4 font-medium">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-un1t-border/50">
                {columns.map((c) => (
                  <td key={c.label} className="py-2 pr-4 align-top">{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function ExceptionsPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/accounting/exceptions')
      const json = await res.json().catch(() => ({}))
      if (cancelled) return
      if (!json.success) setError(json.error || 'Failed to load exceptions')
      else setData(json.data)
    })()
    return () => { cancelled = true }
  }, [])

  if (error) return <div className="text-sm px-3 py-2 rounded bg-red-500/10 text-red-700">{error}</div>
  if (!data) return <Loading />

  const total =
    data.vatMismatches.length + data.agingDrafts.length + data.unattached.length +
    data.receiptless.length + data.stuckRows.length

  if (total === 0) {
    return <EmptyState title="No exceptions" description="The pipeline is clean — nothing needs your attention here. 🎉" />
  }

  return (
    <div className="space-y-4">
      <Section
        title="VAT mismatches — Xero booked ≠ receipt"
        tone="text-red-700"
        intro="The VAT Xero derived from the account's default rate differs from what the receipt shows. Fix the line's tax rate on the bill (or the account default) before the VAT return."
        rows={data.vatMismatches}
        columns={[
          { label: 'Invoice', render: (r) => <span className="text-un1t-text">{r.subject || r.id}</span> },
          { label: 'Xero tax', render: (r) => eur(r.xero_total_tax) },
          { label: 'Receipt tax', render: (r) => eur(r.ocr_tax) },
          { label: 'Forwarded', render: (r) => day(r.forwarded_at) },
          { label: '', render: (r) => <XeroLink url={r.xero_deep_link_url} /> },
        ]}
      />
      <Section
        title="Draft bills aging in Xero"
        tone="text-amber-700"
        intro="Drafts are excluded from VAT returns and can't be matched to bank lines until approved in Xero."
        rows={data.agingDrafts}
        columns={[
          { label: 'Invoice', render: (r) => <span className="text-un1t-text">{r.subject || r.id}</span> },
          { label: 'Bill #', render: (r) => r.xero_bill_number || '—' },
          { label: 'Forwarded', render: (r) => day(r.forwarded_at) },
          { label: 'Status checked', render: (r) => day(r.xero_bill_status_synced_at) },
          { label: '', render: (r) => <XeroLink url={r.xero_deep_link_url} /> },
        ]}
      />
      <Section
        title="Bills missing their document"
        tone="text-red-700"
        intro="The bill exists in Xero but the source file never attached — retry from the invoices inbox so the document travels with the bill."
        rows={data.unattached}
        columns={[
          { label: 'Invoice', render: (r) => <span className="text-un1t-text">{r.subject || r.id}</span> },
          { label: 'Bill #', render: (r) => r.xero_bill_number || '—' },
          {
            label: 'Error',
            render: (r) => (
              <span className="text-xs text-un1t-subtle" title={r.xero_error || ''}>
                {(r.xero_error || '').slice(0, 120)}{(r.xero_error || '').length > 120 ? '…' : ''}
              </span>
            ),
          },
          { label: '', render: (r) => <XeroLink url={r.xero_deep_link_url} /> },
        ]}
      />
      <Section
        title="Receiptless expenses (no document expected)"
        tone="text-gray-700"
        intro="Mileage/cash expenses — legitimate, listed so coverage checks don't read them as missing receipts."
        rows={data.receiptless}
        columns={[
          { label: 'Expense', render: (r) => <span className="text-un1t-text">{r.subject || r.id}</span> },
          { label: 'Status', render: (r) => r.status },
          { label: 'Forwarded', render: (r) => day(r.forwarded_at) },
        ]}
      />
      <Section
        title="Stuck in the queue >7 days"
        tone="text-amber-700"
        intro="Still working through review — worth a look if anything has been sitting a while."
        rows={data.stuckRows}
        columns={[
          { label: 'Item', render: (r) => <span className="text-un1t-text">{r.subject || r.id}</span> },
          { label: 'Status', render: (r) => r.status },
          { label: 'Received', render: (r) => day(r.received_at) },
        ]}
      />
    </div>
  )
}
