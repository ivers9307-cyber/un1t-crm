// Host Overview (HOSTPORTAL.1): a short page — what needs the host's attention,
// the next event on sale with its live numbers, and the next few events. The
// full lists live on Events, Earnings and Your page. Server-rendered + scoped
// to host_id. Everything below the events read is display only: a failed read
// says "unavailable" for that block, never a 0 that looks like an answer.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { getHostRevenue } from '@/lib/host-revenue'
import { createServerClient } from '@/lib/supabase'
import { loadEventStats } from '@/lib/event-stats'
import { loadSessionFill } from '@/lib/host-session-fill'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import { formatInZone, zonedWallClockToInstant } from '@/lib/location-time'
import { PLATFORM_NAME } from '@/lib/brand-name'
import { logWarn } from '@/lib/log'
import {
  HOST_STATUS_CHIP,
  loadHostToday,
  groupHostEvents,
  eventLandingHref,
  formatHostMoney,
  moneyLabel,
  eventMoneyCents,
} from '@/lib/host-portal'
import { HOST_EVENT_STATUS_LABEL } from '@/lib/host-events'
import HostEventRow from '@/components/host/HostEventRow'

export const dynamic = 'force-dynamic'

const H2 = 'text-xs uppercase tracking-[0.15em] text-white/45 mb-3'
const COMING_UP_MAX = 3

function tile({ label, value, sub }) {
  return (
    <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <p className="text-lg font-semibold mt-1 tabular-nums">{value}</p>
      {sub ? <p className="text-xs text-white/40 mt-0.5">{sub}</p> : null}
    </div>
  )
}

export default async function HostOverviewPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')
  const host = session.host

  const db = createServerClient()
  const { data: events, error } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active, status, rejected_reason, venue_name, capacity_mode, entry_policy, race_waves ( id, start_time, capacity, label, display_order )')
    .eq('host_id', host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  if (error) logWarn('host-overview', 'events read failed', { err: error })
  const list = events || []

  const { zone, today } = await loadHostToday(db, host)
  const todayLabel = formatInZone(
    zonedWallClockToInstant(today, '12:00', zone),
    zone,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  )

  const needsStripe = host.payment_provider === 'stripe_connect' && !host.charges_enabled

  const header = (
    <>
      <h1 className="text-2xl font-bold">Welcome, {host.name}.</h1>
      <p className="text-white/60 mt-1 text-sm">{todayLabel}</p>
    </>
  )

  if (error) {
    return (
      <div>
        {header}
        <p className="mt-6 text-white/50 text-sm">Your events are unavailable right now.</p>
      </div>
    )
  }

  const { needsAction, upcoming } = groupHostEvents(list, today)
  const rejected = list.filter((e) => e.status === 'rejected')

  let brandName = PLATFORM_NAME
  if (rejected.some((e) => e.rejected_reason)) {
    try {
      brandName = (await resolveHostOrgBrand(db, host)).name || PLATFORM_NAME
    } catch (e) {
      logWarn('host-overview', 'brand unreadable', { err: e })
    }
  }

  let revenue = null
  try {
    revenue = await getHostRevenue(db, host.id)
  } catch (e) {
    logWarn('host-overview', 'revenue unavailable', { err: e })
  }
  const revenueByEvent = new Map((revenue?.perEvent || []).map((r) => [r.event_id, r]))
  const cur = revenue?.currency || 'EUR'
  const label = moneyLabel(host)

  // Next up: the soonest published event that has not happened yet.
  const next = upcoming.find((e) => e.status === 'published') || null
  let fill = null
  let stats = null
  if (next) {
    const [f, s] = await Promise.all([
      loadSessionFill(db, next).catch((e) => { logWarn('host-overview', 'session fill failed', { err: e }); return { ok: false } }),
      loadEventStats(db, next.id).catch((e) => { logWarn('host-overview', 'event stats failed', { err: e }); return { ok: false } }),
    ])
    fill = f
    stats = s
  }

  function detailFor(e) {
    let d = `${e.race_date || '—'} · ${e.kind}${e.active ? '' : ' · inactive'}`
    const rev = revenueByEvent.get(e.id)
    if (rev) d += ` · ${rev.paidCount} sold · ${formatHostMoney(eventMoneyCents(host, rev), cur)} ${label}`
    return d
  }

  function nextUpCard(e) {
    const chip = HOST_STATUS_CHIP[e.status] || 'bg-white/10 text-white/70'
    const times = (fill?.ok ? fill.sessions : [...(e.race_waves || [])].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))).map((w) => ({ time: String(w.start_time || '').slice(0, 5) })))
      .map((s) => s.time).filter(Boolean)
    const rev = revenueByEvent.get(e.id)
    const fullSessions = fill?.ok ? fill.sessions.filter((s) => s.full) : []

    const booked = !fill?.ok
      ? 'unavailable'
      : fill.capacity === null ? `${fill.booked}` : `${fill.booked} / ${fill.capacity}`
    const bookedSub = fill?.ok && fullSessions.length > 0
      ? `${fullSessions.map((s) => (s.label ? `${s.label} (${s.time})` : s.time)).join(', ')} ${fullSessions.length === 1 ? 'is' : 'are'} full`
      : null
    const statsOk = stats?.ok
    const st = statsOk ? stats.stats : null

    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{e.name}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
            {HOST_EVENT_STATUS_LABEL[e.status] || e.status}
          </span>
        </p>
        <p className="text-xs text-white/45 mt-1 break-words">
          {[e.race_date || '—', times.length > 0 ? times.join(', ') : null, e.venue_name || null].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Link href={`/host/events/${e.id}`} className="rounded-lg border border-white/15 px-3 py-1.5 hover:bg-white/10">Attendees</Link>
          <a href={`/event/${e.slug}`} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 hover:bg-white/10">Event page</a>
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tile({ label: 'Booked', value: booked, sub: bookedSub })}
          {tile({ label: 'Waitlist', value: statsOk ? st.waitlist.waiting : 'unavailable' })}
          {tile({ label: 'Page views', value: statsOk ? st.views : 'unavailable', sub: statsOk && st.conversion_pct !== null && st.conversion_pct !== undefined ? `${st.conversion_pct}% booked` : null })}
          {tile({ label: `${label === 'net' ? 'Net' : 'Gross'} so far`, value: rev ? formatHostMoney(eventMoneyCents(host, rev), cur) : '—', sub: rev ? `${rev.paidCount} sold` : null })}
        </div>
      </div>
    )
  }

  const comingUp = [...needsAction, ...upcoming]
    .sort((a, b) => (a.race_date || '').localeCompare(b.race_date || ''))
    .slice(0, COMING_UP_MAX)

  const hasAttention = needsStripe || rejected.length > 0

  return (
    <div>
      {header}

      {hasAttention && (
        <section className="mt-8">
          <h2 className={H2}>Needs your attention</h2>
          <div className="space-y-2">
            {needsStripe && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Your Stripe account isn&apos;t fully connected yet — ticket payments can&apos;t be taken until it is.
              </div>
            )}
            {rejected.map((e) => (
              <div key={e.id} className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 break-words">
                <strong>{e.name}</strong> needs changes.
                {e.rejected_reason ? ` ${brandName} asked: "${e.rejected_reason}"` : ''}{' '}
                <Link href={eventLandingHref(e)} className="underline underline-offset-2 whitespace-nowrap">Open →</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className={H2}>Next up</h2>
        {next ? nextUpCard(next) : (
          <p className="text-white/50 text-sm">
            <Link href="/host/events/new" className="text-white underline underline-offset-2 hover:text-white/80">Nothing on sale yet — create an event.</Link>
          </p>
        )}
      </section>

      {comingUp.length > 0 && (
        <section className="mt-8">
          <h2 className={H2}>Coming up</h2>
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {comingUp.map((e) => (
              <HostEventRow key={e.id} event={e} detail={detailFor(e)} />
            ))}
          </ul>
          <p className="mt-3 text-xs">
            <Link href="/host/events" className="text-white/60 hover:text-white">All events →</Link>
          </p>
        </section>
      )}
    </div>
  )
}
