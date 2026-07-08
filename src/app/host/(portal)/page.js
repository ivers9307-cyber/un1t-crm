// Host dashboard (HOST-PORTAL.1). Server-rendered + scoped: getCurrentHost() →
// the host's own events (.eq('host_id', host.id)) + a revenue rollup over the
// same host_id (getHostRevenue). Read-only.

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { getHostRevenue } from '@/lib/host-revenue'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function formatMoney(cents, currency) {
  const n = (Number(cents) || 0) / 100
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(n)
  } catch {
    return `€${n.toFixed(2)}`
  }
}

export default async function HostDashboard() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const { data: events } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active')
    .eq('host_id', session.host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  const list = events || []

  let revenue = null
  try {
    revenue = await getHostRevenue(db, session.host.id)
  } catch {
    revenue = null
  }
  const cur = revenue?.currency || 'EUR'
  const netByEvent = new Map((revenue?.perEvent || []).map((r) => [r.event_id, r]))

  // Only Stripe-Connect hosts have a UN1T booking fee + a settled "net to host"
  // (mig 381 columns). Revolut/internal hosts collect directly, so those columns
  // are NULL (→0) and would misrepresent as "€0 net" — show them gross only.
  const isStripe = session.host.payment_provider === 'stripe_connect'
  const needsStripe = isStripe && !session.host.charges_enabled

  const tiles = !revenue
    ? []
    : isStripe
      ? [
          { label: 'Gross collected', value: formatMoney(revenue.totals.gross_cents, cur) },
          { label: 'UN1T booking fees', value: formatMoney(revenue.totals.fee_cents, cur) },
          { label: 'Net to you', value: formatMoney(revenue.totals.net_to_host_cents, cur) },
          { label: 'Refunded', value: formatMoney(revenue.totals.refunded_cents, cur) },
        ]
      : [
          { label: 'Gross collected', value: formatMoney(revenue.totals.gross_cents, cur) },
          { label: 'Refunded', value: formatMoney(revenue.totals.refunded_cents, cur) },
        ]
  const tilesGridCls = tiles.length === 4
    ? 'grid grid-cols-2 sm:grid-cols-4 gap-3'
    : 'grid grid-cols-2 gap-3 max-w-md'

  return (
    <div>
      <h1 className="text-2xl font-bold">Welcome, {session.host.name}.</h1>
      <p className="text-white/60 mt-1 text-sm">Your events and earnings at a glance.</p>

      {needsStripe && (
        <div className="mt-6 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Your Stripe account isn&apos;t fully connected yet — ticket payments can&apos;t be taken until it is.
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Revenue</h2>
        {revenue === null ? (
          <p className="text-white/40 text-sm">Revenue is unavailable right now.</p>
        ) : revenue.totals.paidCount === 0 ? (
          <p className="text-white/50 text-sm">No ticket sales yet.</p>
        ) : (
          <>
            <div className={tilesGridCls}>
              {tiles.map((t) => (
                <div key={t.label} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-white/40">{t.label}</p>
                  <p className="text-lg font-semibold mt-1 tabular-nums">{t.value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-white/40 mt-2">
              {revenue.totals.paidCount} paid booking{revenue.totals.paidCount === 1 ? '' : 's'} ·{' '}
              {formatMoney(revenue.totals.net_collected_cents, cur)} collected after refunds
            </p>
          </>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your events</h2>
        {list.length === 0 ? (
          <p className="text-white/50 text-sm">No events assigned to you yet.</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {list.map((e) => {
              const rev = netByEvent.get(e.id)
              return (
                <li key={e.id} className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-white/[0.02]">
                  <a href={`/host/events/${e.id}`} className="min-w-0 flex-1">
                    <p className="font-medium truncate">{e.name}</p>
                    <p className="text-xs text-white/45">
                      {e.race_date || '—'} · {e.kind}{e.active ? '' : ' · inactive'}
                      {rev ? ` · ${rev.paidCount} sold · ${formatMoney(isStripe ? rev.net_to_host_cents : rev.gross_cents, cur)} ${isStripe ? 'net' : 'gross'}` : ''}
                    </p>
                  </a>
                  <div className="shrink-0 flex items-center gap-4 text-xs">
                    <a href={`/host/events/${e.id}`} className="text-white/50 hover:text-white">Attendees →</a>
                    <a href={`/event/${e.slug}`} target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-white">
                      View
                    </a>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className="text-white/30 text-xs mt-10">Read-only. Self-serve event creation lands next.</p>
    </div>
  )
}
