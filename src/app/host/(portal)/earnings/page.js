// Host earnings (HOSTPORTAL.1): revenue tiles, by-event money, Stripe balance,
// payouts and monthly statements in one place. Server-rendered + scoped to the
// signed-in host; the payouts block self-fetches once through the provider.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { getHostRevenue } from '@/lib/host-revenue'
import { createServerClient } from '@/lib/supabase'
import { PLATFORM_NAME } from '@/lib/brand-name'
import { formatHostMoney, eventMoneyCents, moneyLabel } from '@/lib/host-portal'
import { HostPayoutsProvider, HostBalance, HostPayoutList } from '@/components/host/HostPayouts'
import HostStatements from '@/components/host/HostStatements'

export const dynamic = 'force-dynamic'

export default async function HostEarningsPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  let revenue = null
  try {
    revenue = await getHostRevenue(db, session.host.id)
  } catch {
    revenue = null
  }
  const cur = revenue?.currency || 'EUR'

  // Only Stripe-Connect hosts have a platform booking fee + a settled "net to host"
  // (mig 381 columns). Revolut/internal hosts collect directly, so those columns
  // are NULL (→0) and would misrepresent as "€0 net" — show them gross only.
  const isStripe = session.host.payment_provider === 'stripe_connect'
  const label = moneyLabel(session.host)

  const tiles = !revenue
    ? []
    : isStripe
      ? [
          { label: 'Gross collected', value: formatHostMoney(revenue.totals.gross_cents, cur) },
          // W1.S1c: the per-ticket fee is the platform's money rail (Stripe
          // Connect application fee), so it carries the platform name.
          { label: `${PLATFORM_NAME} booking fees`, value: formatHostMoney(revenue.totals.fee_cents, cur) },
          { label: 'Net to you', value: formatHostMoney(revenue.totals.net_to_host_cents, cur) },
          { label: 'Refunded', value: formatHostMoney(revenue.totals.refunded_cents, cur) },
        ]
      : [
          { label: 'Gross collected', value: formatHostMoney(revenue.totals.gross_cents, cur) },
          { label: 'Refunded', value: formatHostMoney(revenue.totals.refunded_cents, cur) },
        ]
  const tilesGridCls = tiles.length === 4
    ? 'grid grid-cols-2 sm:grid-cols-4 gap-3'
    : 'grid grid-cols-2 gap-3 max-w-md'

  const hasSales = !!revenue && revenue.totals.paidCount > 0
  const perEvent = hasSales ? revenue.perEvent || [] : []

  return (
    <HostPayoutsProvider>
      <h1 className="text-2xl font-bold">Earnings</h1>

      {hasSales && (
        <p className="text-xs text-white/40 mt-2">
          {revenue.totals.paidCount} paid booking{revenue.totals.paidCount === 1 ? '' : 's'} ·{' '}
          {formatHostMoney(revenue.totals.net_collected_cents, cur)} collected after refunds
        </p>
      )}
      {isStripe && session.host.stripe_connected_account_id && (
        <p className="mt-3">
          <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer"
             className="text-xs text-white/40 hover:text-white">Stripe dashboard →</a>
        </p>
      )}

      <HostBalance />

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">All time</h2>
        {revenue === null ? (
          <p className="text-white/40 text-sm">Revenue is unavailable right now.</p>
        ) : !hasSales ? (
          <p className="text-white/50 text-sm">No ticket sales yet.</p>
        ) : (
          <div className={tilesGridCls}>
            {tiles.map((t) => (
              <div key={t.label} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[11px] uppercase tracking-wide text-white/40">{t.label}</p>
                <p className="text-lg font-semibold mt-1 tabular-nums">{t.value}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {perEvent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">By event</h2>
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {perEvent.map((r) => (
              <li key={r.event_id}>
                <Link href={`/host/events/${r.event_id}`}
                      className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-white/[0.02]">
                  <span className="min-w-0">
                    <span className="block font-medium truncate">{r.name}</span>
                    <span className="block text-xs text-white/45">{r.race_date || '—'} · {r.paidCount} sold</span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums" title={label}>
                    {formatHostMoney(eventMoneyCents(session.host, r), cur)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <HostPayoutList />

      <HostStatements />
    </HostPayoutsProvider>
  )
}
