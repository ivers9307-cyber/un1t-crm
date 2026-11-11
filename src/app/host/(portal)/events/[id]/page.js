// Overview tab of a host's event page (HOSTPORTAL.2): four tiles (bookings,
// waitlist, page views, money), the sessions' fill, and the price right now.
// Read-only. The layout above renders the header, actions and tab strip; this
// page repeats the gate (getCurrentHost + loadHostEvent) because a layout is
// never the only gate. Each read fails on its own: a failed one renders that
// block's "unavailable" text and the rest of the page still renders.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent, loadHostToday, attendeeCounts, formatHostMoney, moneyLabel, eventMoneyCents } from '@/lib/host-portal'
import { fetchEventAttendees } from '@/lib/attendee-export'
import { loadEventStats } from '@/lib/event-stats'
import { loadSessionFill } from '@/lib/host-session-fill'
import { getHostRevenue } from '@/lib/host-revenue'
import { loadSoldByTier, resolvePricingTiers } from '@/lib/pricing-tiers'
import { hostPriceLine } from '@/lib/host-price-line'
import { logWarn } from '@/lib/log'
import SessionFillBars from '@/components/host/SessionFillBars'
import { HOST_EYEBROW } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, host_id, capacity_mode, entry_policy, non_member_fee_cents, pricing_tiers, allowed_team_sizes, race_waves ( id, start_time, capacity, label, display_order )'

// A read that throws or fails is null, logged; the page shows "unavailable".
async function safely(label, fn) {
  try {
    return await fn()
  } catch (e) {
    logWarn('host-overview', `${label} read failed`, { err: e })
    return null
  }
}

function tile(label, value, sub) {
  return (
    <div key={label} className="rounded-xl border border-host-border bg-host-panel p-4 min-w-0">
      <p className={HOST_EYEBROW}>{label}</p>
      <p className="mt-2 text-2xl font-semibold text-host-text break-words">{value}</p>
      {sub && <p className="mt-1 text-xs text-host-hint">{sub}</p>}
    </div>
  )
}

export default async function HostEventOverview(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const race = await loadHostEvent(db, session.host.id, params.id, COLUMNS)
  if (!race) notFound()

  const [regs, statsRes, fill, revenue, { zone }, soldRes] = await Promise.all([
    safely('attendees', () => fetchEventAttendees(db, race.id)),
    safely('stats', () => loadEventStats(db, race.id)),
    safely('session fill', () => loadSessionFill(db, race)),
    safely('revenue', () => getHostRevenue(db, session.host.id)),
    loadHostToday(db, session.host),
    // No tiers, nothing sold against a tier: no read to fail.
    resolvePricingTiers(race).length === 0
      ? Promise.resolve({ ok: true, soldByTier: {} })
      : safely('sold by tier', () => loadSoldByTier(db, { eventId: race.id, race })),
  ])

  const stats = statsRes?.ok ? statsRes.stats : null
  const sessions = fill?.ok ? fill.sessions : null
  const counts = Array.isArray(regs) ? attendeeCounts(regs) : null

  const label = moneyLabel(session.host)
  const row = revenue ? (revenue.perEvent || []).find((r) => r.event_id === race.id) : null
  const money = (cents) => formatHostMoney(cents, revenue?.currency)
  let moneyValue = 'unavailable'
  let moneySub = null
  if (revenue) {
    moneyValue = row ? money(eventMoneyCents(session.host, row)) : '—'
    if (row && label === 'net') moneySub = `${money(row.gross_cents)} gross`
  }

  const priceLine = soldRes?.ok
    ? hostPriceLine({ race, soldByTier: soldRes.soldByTier, nowMs: Date.now(), zone })
    : null

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile(
          'Bookings',
          counts ? counts.bookings : 'unavailable',
          counts ? `${counts.confirmed} confirmed · ${counts.people} attendee${counts.people === 1 ? '' : 's'}` : null,
        )}
        {tile('Waitlist', stats ? stats.waitlist.waiting : 'unavailable', stats ? `${stats.waitlist.offered} offered` : null)}
        {tile(
          'Page views',
          stats ? stats.views : 'unavailable',
          stats && stats.conversion_pct != null ? `${stats.conversion_pct}% of visitors booked` : null,
        )}
        {tile(label === 'net' ? 'Net to you' : 'Gross', moneyValue, moneySub)}
      </div>

      <section aria-label="Sessions" className="mt-6 rounded-xl border border-host-border bg-host-panel p-4">
        <h2 className={HOST_EYEBROW}>Sessions</h2>
        <div className="mt-3">
          {sessions
            ? (sessions.length > 0
              ? <SessionFillBars sessions={sessions} />
              : <p className="text-sm text-host-hint">No sessions yet.</p>)
            : <p className="text-sm text-host-hint">Session numbers unavailable right now.</p>}
        </div>
      </section>

      <section aria-label="Price right now" className="mt-4 rounded-xl border border-host-border bg-host-panel p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h2 className={HOST_EYEBROW}>Price right now</h2>
          <a href={`/host/events/${race.id}/setup`} className="text-xs text-host-hint hover:text-host-text">Change in Set up →</a>
        </div>
        <p className="mt-2 text-sm text-host-text break-words">{priceLine ?? 'Price unavailable right now.'}</p>
      </section>
    </div>
  )
}
