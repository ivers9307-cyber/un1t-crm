// HATCHPIPE.2 — what un1t.online says a contact owes and has paid, per studio.
// Server component, display only: the data comes from loadUn1tBilling()
// (src/lib/contact-un1t-billing.js), which has already checked the viewer may
// see each studio. Renders nothing when there is no studio to show.

import { formatDate, formatMoney } from './format'

const MAX_TRANSACTIONS = 10

const CHIP = 'text-[10px] font-medium px-1.5 py-0.5 rounded-full'

const INVOICE_CHIP = {
  paid: { cls: 'bg-emerald-500/10 text-emerald-700', text: 'Paid' },
  open: { cls: 'bg-red-500/10 text-red-700', text: 'Open' },
  void: { cls: 'bg-zinc-500/10 text-zinc-700', text: 'Void' },
}

function invoiceChip(inv) {
  const known = INVOICE_CHIP[inv.status]
  if (known) return known
  // An unrecognised status is shown as un1t.online spelt it, never guessed at.
  return { cls: 'bg-zinc-500/10 text-zinc-700', text: inv.rawStatus || 'Unknown' }
}

// One band per overdue subscription, each with its own amount.
function OverdueBand({ pastDue }) {
  // formatMoney defaults a missing currency to €, so an amount with no currency
  // is as unreported as one with no amount.
  const amount = pastDue.currency ? formatMoney(pastDue.amountCents, pastDue.currency) : null
  const since = formatDate(pastDue.since)
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
      <div className="font-medium">{since ? `Payment overdue since ${since}` : 'Payment overdue'}</div>
      <div>{amount || 'amount not reported by un1t.online'}</div>
    </div>
  )
}

function StudioBlock({ studio }) {
  const { locationName, subscriptions = [], transactions = [], invoices = [], pastDues = [] } = studio
  const shownTransactions = transactions.slice(0, MAX_TRANSACTIONS)
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-un1t-text">{locationName}</div>

      {pastDues.map((p, i) => <OverdueBand key={`due-${i}`} pastDue={p} />)}

      {subscriptions.length > 0 && (
        <ul className="space-y-1">
          {subscriptions.map((s, i) => (
            <li key={`sub-${i}`} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-un1t-text">{s.productTitle || 'Subscription'}</span>
              <span className="shrink-0 text-xs text-un1t-subtle">
                {[s.status, formatMoney(s.priceCents, s.currency), s.interval].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {shownTransactions.length === 0 ? (
        <p className="text-sm text-un1t-muted">No payments recorded</p>
      ) : (
        <ul className="space-y-1">
          {shownTransactions.map((t, i) => (
            <li key={`tx-${i}`} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <span className="text-un1t-text">{t.productTitle || 'Payment'}</span>
                <span className="ml-1.5 text-[11px] text-un1t-subtle">{formatDate(t.at)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {t.refunded && <span className={`${CHIP} bg-amber-500/10 text-amber-700`}>Refunded</span>}
                <span className="text-xs font-medium text-un1t-text">{formatMoney(t.amountCents, t.currency) || '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {invoices.length > 0 && (
        <ul className="space-y-1 border-t border-un1t-border pt-2">
          {invoices.map((inv, i) => {
            const chip = invoiceChip(inv)
            return (
              <li key={`inv-${i}`} className="flex items-center justify-between gap-2 text-xs text-un1t-subtle">
                <span>Invoice {formatDate(inv.at) || ''}</span>
                <div className="flex items-center gap-1.5">
                  <span>{formatMoney(inv.amountCents, inv.currency) || '—'}</span>
                  <span className={`${CHIP} ${chip.cls}`}>{chip.text}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function Un1tPaymentsCard({ studios }) {
  if (!Array.isArray(studios) || studios.length === 0) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Payments on un1t.online</h3>
      {studios.map((s) => <StudioBlock key={s.locationId} studio={s} />)}
    </div>
  )
}
