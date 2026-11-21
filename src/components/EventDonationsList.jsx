'use client'

// CHARITY.10 — staff view of an event's card donations: totals tiles, the
// table, the CSV hand-over, and the record-only "Mark as refunded". An
// awaiting_payment row of any age is listed as Unconfirmed with a Re-check
// (the public status route asks the provider and runs the paid side effects),
// so a manager can reconcile it against the provider dashboard. A paid row
// whose receipt failed or never went, or that has no linked contact, gets the
// same Re-check: a staff click always lands after the status route's
// single-sender minute, so it re-runs the stamp-keyed side effects. The server
// renders paid_at in the event's zone (paid_at_label), so nothing here does
// zone maths. RAFFLEDONATIONS.2 — the event's unvoided raffle sales are
// listed in the same table with a Raffle chip: never matched, no actions (a
// sale is voided on the raffle page).
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

const RAFFLE_CHIP = { label: 'Raffle', cls: 'bg-violet-500/10 text-violet-700' }

// One table row per raffle sale, in the donation row's shape.
function raffleRow(r) {
  const how = r.channel === 'online' ? 'online' : (r.payment_method === 'cash' ? 'cash' : 'card')
  const tickets = `${r.quantity} ${r.quantity === 1 ? 'ticket' : 'tickets'}`
  return {
    id: `raffle-${r.id}`,
    kind: 'raffle',
    at: r.sold_at,
    paid_at_label: r.sold_at_label,
    donor_name: r.buyer_name,
    donor_email: r.buyer_email,
    amount_cents: r.total_cents,
    receipt_email_status: r.email_status,
    message: `${tickets} ${r.tickets_label} · ${how}${r.option_label ? ` (${r.option_label})` : ''}`,
  }
}

// Donations and raffle sales together, newest first; rows with no time last.
export function mergeRows(donations = [], raffleSales = []) {
  const rows = [
    ...donations.map((d) => ({ ...d, kind: 'donation', at: d.paid_at })),
    ...raffleSales.map(raffleRow),
  ]
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      if (!a.row.at && !b.row.at) return a.i - b.i
      if (!a.row.at) return 1
      if (!b.row.at) return -1
      return Date.parse(b.row.at) - Date.parse(a.row.at) || a.i - b.i
    })
    .map(({ row }) => row)
}

// Unconfirmed, or paid with a side effect still outstanding.
const needsRecheck = (d) => d.status === 'awaiting_payment'
  || (d.status === 'paid' && (!d.receipt_email_status || d.receipt_email_status === 'failed' || !d.contact_id))

function StatusChip({ status, raffle = false }) {
  const chip = raffle ? RAFFLE_CHIP : STATUS_CHIP[status] || { label: status, cls: 'bg-un1t-surface text-un1t-subtle' }
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
    { key: 'matched', header: matchLabel, align: 'right', render: (d) => (d.kind !== 'raffle' && d.status === 'paid' ? formatCents(d.matched_cents, d.currency || currency) : '—') },
    { key: 'status', header: 'Status', render: (d) => <StatusChip status={d.status} raffle={d.kind === 'raffle'} /> },
    { key: 'receipt', header: 'Receipt', render: (d) => <span data-col="receipt">{RECEIPT_LABEL[d.receipt_email_status] || '—'}</span> },
    { key: 'message', header: 'Message', render: (d) => <span className="text-un1t-subtle">{d.message || ''}</span> },
    {
      key: 'actions', header: '', align: 'right',
      render: (d) => {
        if (d.kind === 'raffle') return null
        const recheckButton = needsRecheck(d) ? (
          <Button type="button" variant="ghost" size="sm" loading={recheckingId === d.id} onClick={() => recheck(d)}>
            Re-check
          </Button>
        ) : null
        const refundButton = canMarkRefunded && d.status === 'paid' ? (
          <Button type="button" variant="ghost" size="sm" loading={busyId === d.id} onClick={() => markRefunded(d)}>
            Mark as refunded
          </Button>
        ) : null
        if (!recheckButton && !refundButton) return null
        return <div className="flex justify-end gap-1">{recheckButton}{refundButton}</div>
      },
    },
  ]

  return (
    <div>
      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2">{error}</div>
      )}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3 mb-5">
          <Tile label="Raised" value={formatCents(totals.raised_cents, currency)} hint={data.settings?.name || undefined} />
          <Tile label="Donations" value={formatCents(totals.donations_cents, currency)} hint={`${totals.donation_count} paid`} />
          <Tile label="Donations matched" value={formatCents(totals.donations_matched_cents, currency)} />
          {data.settings?.include_entries && (
            <Tile label="Entries matched" value={formatCents(totals.entries_matched_cents, currency)} hint={`${formatCents(totals.entries_cents, currency)} in entries`} />
          )}
          {/* RAFFLEDONATIONS.1 — raffle money (till + online), counted in Raised, not matched. */}
          {data.settings?.has_raffle && (
            <Tile label="Raffle" value={formatCents(totals.raffle_cents, currency)} hint={`${totals.raffle_ticket_count} tickets · not matched`} />
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
        rows={mergeRows(data?.donations || [], data?.raffle_sales || [])}
        loading={!data && !error}
        empty="No donations yet."
      />
    </div>
  )
}
