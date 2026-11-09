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
import { formatInZone, zonedWallClockToInstant, addDaysISO } from '@/lib/location-time'
import { loadHostRollup, loadRecentRatingCounts } from '@/lib/host-rollup'
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
  hostEventDetail,
} from '@/lib/host-portal'
import { HOST_EVENT_STATUS_LABEL, eventIsPublic } from '@/lib/host-events'
import HostEventRow from '@/components/host/HostEventRow'
import { HOST_CHIP, HOST_CHIP_TONE, HOST_EYEBROW, HOST_H1, HOST_HINT, HOST_LINK, HOST_LIST, HOST_META, HOST_NOTICE, HOST_NOTICE_TONE } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

const H2 = `${HOST_EYEBROW} mb-3`
const COMING_UP_MAX = 3
const RATING_LINES_MAX = 3

function tile({ label, value, sub }) {
  return (
    <div key={label} className="rounded-xl border border-host-border bg-host-panel px-4 py-3">
      <p className={HOST_META}>{label}</p>
      <p className="text-lg font-semibold mt-1 tabular-nums">{value}</p>
      {sub ? <p className={`${HOST_META} mt-0.5`}>{sub}</p> : null}
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
      <h1 className={HOST_H1}>Welcome, {host.name}.</h1>
      <p className="text-host-hint mt-1 text-sm">{todayLabel}</p>
    </>
  )
  const stripeWarning = needsStripe && (
    <div className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.warn}`}>
      Your Stripe account isn&apos;t fully connected yet — ticket payments can&apos;t be taken until it is.
    </div>
  )

  if (error) {
    return (
      <div>
        {header}
        {stripeWarning && <div className="mt-6">{stripeWarning}</div>}
        <p className={`mt-6 ${HOST_HINT}`}>Your events are unavailable right now.</p>
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
  // Last 30 days: a windowed revenue read beside the all-time one above.
  const sinceDay = addDaysISO(today, -30)
  const sinceMs = zonedWallClockToInstant(sinceDay, '00:00', zone)
  const sinceIso = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null
  let windowRevenue = null
  let rollup = { bookings: null, views: null, signups: null, contacts: null }
  if (sinceIso) {
    try {
      windowRevenue = await getHostRevenue(db, host.id, { sinceIso })
    } catch (e) {
      logWarn('host-overview', 'windowed revenue unavailable', { err: e })
    }
    rollup = await loadHostRollup(db, { hostId: host.id, eventIds: list.map((e) => e.id), sinceIso, sinceDay })
  }
  // New ratings this week: a notice, not a figure, so a failed read is no line.
  const ratingSinceDay = addDaysISO(today, -7)
  const ratingSinceMs = zonedWallClockToInstant(ratingSinceDay, '00:00', zone)
  let ratingLines = []
  if (Number.isFinite(ratingSinceMs)) {
    const counts = await loadRecentRatingCounts(db, {
      eventIds: list.map((e) => e.id),
      sinceIso: new Date(ratingSinceMs).toISOString(),
    })
    if (counts === null) {
      logWarn('host-overview', 'recent ratings unavailable')
    } else {
      ratingLines = list
        .filter((e) => (counts.get(e.id) || 0) > 0)
        .sort((a, b) => (b.race_date || '').localeCompare(a.race_date || ''))
        .slice(0, RATING_LINES_MAX)
        .map((e) => ({ id: e.id, name: e.name, n: counts.get(e.id) }))
    }
  }
  const unavailable = (n) => (n === null || n === undefined ? 'unavailable' : n)
  const revenueByEvent = new Map((revenue?.perEvent || []).map((r) => [r.event_id, r]))
  const cur = revenue?.currency || 'EUR'
  const label = moneyLabel(host)

  // Next up: the soonest upcoming event that is actually on sale (published
  // AND active; one the host took off sale is not "next").
  const next = upcoming.find((e) => eventIsPublic(e)) || null
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

  function nextUpCard(e) {
    const chip = HOST_STATUS_CHIP[e.status] || `${HOST_CHIP} ${HOST_CHIP_TONE.neutral}`
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
      <div className="rounded-xl border border-host-border bg-host-panel p-4">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{e.name}</span>
          <span className={`shrink-0 ${chip}`}>
            {HOST_EVENT_STATUS_LABEL[e.status] || e.status}
          </span>
        </p>
        <p className={`${HOST_META} mt-1 break-words`}>
          {[e.race_date || '—', times.length > 0 ? times.join(', ') : null, e.venue_name || null].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Link href={`/host/events/${e.id}/attendees`} className="rounded-lg border border-host-edge px-3 py-1.5 text-host-text hover:bg-host-hover">Attendees</Link>
          <a href={`/event/${e.slug}`} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-host-edge px-3 py-1.5 text-host-hint hover:bg-host-hover">Event page</a>
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tile({ label: 'Booked', value: booked, sub: bookedSub })}
          {tile({ label: 'Waitlist', value: statsOk ? st.waitlist.waiting : 'unavailable' })}
          {tile({ label: 'Page views', value: statsOk ? st.views : 'unavailable', sub: statsOk && st.conversion_pct !== null && st.conversion_pct !== undefined ? `${st.conversion_pct}% booked` : null })}
          {tile({ label: `${label === 'net' ? 'Net' : 'Gross'} so far`, value: rev ? formatHostMoney(eventMoneyCents(host, rev), cur) : revenue === null ? 'unavailable' : '—', sub: rev ? `${rev.paidCount} sold` : null })}
        </div>
      </div>
    )
  }

  const comingUp = [...needsAction, ...upcoming]
    .sort((a, b) => (a.race_date || '').localeCompare(b.race_date || ''))
    .slice(0, COMING_UP_MAX)

  const hasAttention = needsStripe || rejected.length > 0 || ratingLines.length > 0

  return (
    <div>
      {header}

      {hasAttention && (
        <section className="mt-8">
          <h2 className={H2}>Needs your attention</h2>
          <div className="space-y-2">
            {stripeWarning}
            {rejected.map((e) => (
              <div key={e.id} className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.warn} break-words`}>
                <strong>{e.name}</strong> needs changes.
                {e.rejected_reason ? ` ${brandName} asked: "${e.rejected_reason}"` : ''}{' '}
                <Link href={eventLandingHref(e)} className="underline underline-offset-2 whitespace-nowrap">Open →</Link>
              </div>
            ))}
            {ratingLines.map((r) => (
              <div key={r.id} className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.neutral} break-words`}>
                {r.n} new rating{r.n === 1 ? '' : 's'} on <strong>{r.name}</strong> this week.{' '}
                <Link href={`/host/events/${r.id}/insights`} className="underline underline-offset-2 whitespace-nowrap">Read them →</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className={H2}>Next up</h2>
        {next ? nextUpCard(next) : (
          <p className={HOST_HINT}>
            <Link href="/host/events/new" className={HOST_LINK}>Nothing on sale yet — create an event.</Link>
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className={H2}>Last 30 days</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tile({ label: 'Bookings', value: unavailable(rollup.bookings) })}
          {tile({
            label: label === 'net' ? 'Net earned' : 'Gross collected',
            value: windowRevenue
              ? formatHostMoney(label === 'net' ? windowRevenue.totals.net_to_host_cents : windowRevenue.totals.gross_cents, windowRevenue.currency || cur)
              : 'unavailable',
          })}
          {tile({ label: 'Event page views', value: unavailable(rollup.views), sub: 'across all events' })}
          {tile({ label: 'List signups', value: unavailable(rollup.signups), sub: rollup.contacts === null ? null : `${rollup.contacts} contacts` })}
        </div>
      </section>

      {comingUp.length > 0 && (
        <section className="mt-8">
          <h2 className={H2}>Coming up</h2>
          <ul className={`${HOST_LIST} overflow-hidden`}>
            {comingUp.map((e) => (
              <HostEventRow key={e.id} event={e} detail={hostEventDetail(host, e, revenueByEvent.get(e.id), cur)} />
            ))}
          </ul>
          <p className="mt-3 text-xs">
            <Link href="/host/events" className="text-host-hint hover:text-host-text">All events →</Link>
          </p>
        </section>
      )}
    </div>
  )
}
