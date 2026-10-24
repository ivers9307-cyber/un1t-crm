'use client'

// CHARITY.10 — staff view of an event's card donations: totals tiles, the
// table, the CSV hand-over, and the record-only "Mark as refunded". An
// awaiting_payment row of any age is listed as Unconfirmed with a Re-check
// (the public status route asks the provider and runs the paid side effects),
// so a manager can reconcile it against the provider dashboard. The server
// renders paid_at in the event's zone (paid_at_label), so nothing here does
// zone maths.
import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button, Table } from '@/components/ui'
import { formatCents } from '@/lib/charity-donations'

const STATUS_CHIP = {
  paid: { label: 'Paid', cls: 'bg-emerald-500/10 text-emerald-700' },
  refunded: { label: 'Refunded', cls: 'bg-amber-500/10 text-amber-700' },
  failed: { label: 'Failed', cls: 'bg-red-500/10 text-red-700' },
  expired: { label: 'Expired', cls: 'bg-red-500/10 text-red-700' },
  awaiting_payment: { label: 'Unconfirmed', cls: 'bg-sky-500/10 text-sky-700' },
}

const RECEIPT_LABEL = { sent: 'Sent', suppressed: 'Suppressed', failed: 'Failed' }

function StatusChip({ status }) {
  const chip = STATUS_CHIP[status] || { label: status, cls: 'bg-un1t-surface text-un1t-subtle' }
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>{chip.label}</span>
}

function Tile({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-un1t-border p-3">
      <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">{label}</div>
      <div className="text-xl font-semibold text-un1t-text mt-0.5">{value}</div>
      {hint && <div className="text-[11px] text-un1t-subtle mt-0.5">{hint}</div>}
    </div>
  )
}

export default function EventDonationsList({ raceId, canMarkRefunded = false }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [recheckingId, setRecheckingId] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${raceId}/donations`)
      const body = await res.json()
      if (!res.ok || !body?.success) { setError(body?.error || 'Could not load donations'); return }
      setError('')
      setData(body.data)
    } catch {
      setError('Could not load donations')
    }
  }, [raceId])

  useEffect(() => { load() }, [load])

  async function markRefunded(d) {
    if (!window.confirm(`Mark ${formatCents(d.amount_cents, d.currency)} from ${d.donor_name || d.donor_email || 'this donor'} as refunded? Refund the card in your payment provider first; this only records it.`)) return
    setBusyId(d.id)
    try {
      const res = await fetch(`/api/events/${raceId}/donations/${d.id}/refunded`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.success) setError(body?.error || 'Could not mark as refunded')
      else await load()
    } catch {
      setError('Could not mark as refunded')
    } finally {
      setBusyId(null)
    }
  }

  // The public status route re-checks the provider for a pending row and runs
  // the paid side effects when it has settled; then the list is reloaded.
  async function recheck(d) {
    setRecheckingId(d.id)
    try {
      const res = await fetch(`/api/public/donations/${d.id}`)
      if (!res.ok) setError('Could not re-check this payment')
      else await load()
    } catch {
      setError('Could not re-check this payment')
    } finally {
      setRecheckingId(null)
    }
  }

  const currency = data?.currency || 'EUR'
  const totals = data?.totals
  const mult = data?.settings?.match_multiplier || 1
  const matchLabel = mult > 1 ? `Matched (×${mult})` : 'Matched'

  const columns = [
    { key: 'when', header: 'Paid', render: (d) => d.paid_at_label || '—' },
    {
      key: 'donor', header: 'Donor',
      render: (d) => (
        <div>
          <div>{d.donor_name || '—'}</div>
          <div className="text-[11px] text-un1t-subtle">{d.donor_email}</div>
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (d) => formatCents(d.amount_cents, d.currency || currency) },
    { key: 'matched', header: matchLabel, align: 'right', render: (d) => (d.status === 'paid' ? formatCents(d.matched_cents, d.currency || currency) : '—') },
    { key: 'status', header: 'Status', render: (d) => <StatusChip status={d.status} /> },
    { key: 'receipt', header: 'Receipt', render: (d) => <span data-col="receipt">{RECEIPT_LABEL[d.receipt_email_status] || '—'}</span> },
    { key: 'message', header: 'Message', render: (d) => <span className="text-un1t-subtle">{d.message || ''}</span> },
    {
      key: 'actions', header: '', align: 'right',
      render: (d) => {
        if (d.status === 'awaiting_payment') {
          return (
            <Button type="button" variant="ghost" size="sm" loading={recheckingId === d.id} onClick={() => recheck(d)}>
              Re-check
            </Button>
          )
        }
        return canMarkRefunded && d.status === 'paid' ? (
          <Button type="button" variant="ghost" size="sm" loading={busyId === d.id} onClick={() => markRefunded(d)}>
            Mark as refunded
          </Button>
        ) : null
      },
    },
  ]

  return (
    <div>
      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2">{error}</div>
      )}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Tile label="Raised" value={formatCents(totals.raised_cents, currency)} hint={data.settings?.name || undefined} />
          <Tile label="Donations" value={formatCents(totals.donations_cents, currency)} hint={`${totals.donation_count} paid`} />
          <Tile label="Donations matched" value={formatCents(totals.donations_matched_cents, currency)} />
          {data.settings?.include_entries && (
            <Tile label="Entries matched" value={formatCents(totals.entries_matched_cents, currency)} hint={`${formatCents(totals.entries_cents, currency)} in entries`} />
          )}
        </div>
      )}
      <div className="flex justify-end mb-2">
        <Button as="a" variant="secondary" size="sm" icon={Download} href={`/api/events/${raceId}/donations?format=csv`}>
          Export CSV
        </Button>
      </div>
      <Table
        columns={columns}
        rows={data?.donations || []}
        loading={!data && !error}
        empty="No donations yet."
      />
    </div>
  )
}
