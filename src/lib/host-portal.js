// Host portal helpers (HOSTPORTAL.1): the reads and rules the /host pages share.
// Server-side only (takes a service-role client). Scoping rule: a host's event is
// read through loadHostEvent, which answers null for another host's event id.

import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { todayIsoIn } from '@shared/events'
import { logWarn } from '@/lib/log'

// Dark-surface status chips: light text on translucent dark fills (the host
// pages are bg-black, so the light-theme -700 chip rule does not apply).
export const HOST_STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  pending_review: 'bg-amber-500/15 text-amber-300',
  published: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-red-500/15 text-red-300',
}

export function formatHostMoney(cents, currency) {
  const n = (Number(cents) || 0) / 100
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(n)
  } catch {
    return `€${n.toFixed(2)}`
  }
}

/** Stripe-Connect hosts see net; everyone else collects directly and sees gross. */
export function moneyLabel(host) {
  return host?.payment_provider === 'stripe_connect' ? 'net' : 'gross'
}

export function eventMoneyCents(host, perEventRow) {
  return moneyLabel(host) === 'net' ? perEventRow?.net_to_host_cents : perEventRow?.gross_cents
}

/**
 * The detail line under an event's name in a host list row: date, kind,
 * inactive flag, then sold + money when the event has a revenue row, then the
 * public rating when one is given. Pure; revenueRow and rating may be null.
 */
export function hostEventDetail(host, event, revenueRow, currency, { rating = null } = {}) {
  let d = `${event.race_date || '—'} · ${event.kind}${event.active ? '' : ' · inactive'}`
  if (revenueRow) d += ` · ${revenueRow.paidCount} sold · ${formatHostMoney(eventMoneyCents(host, revenueRow), currency)} ${moneyLabel(host)}`
  if (rating) d += ` · ★ ${rating.average} (${rating.count})`
  return d
}

/**
 * "Today" on the host's anchor studio clock. Any failure (unreadable host row
 * or zone) logs and falls back to the platform default zone.
 */
export async function loadHostToday(db, host) {
  let zone = DEFAULT_TZ
  try {
    const { data: anchor, error } = await db
      .from('event_hosts')
      .select('anchor_location_id')
      .eq('id', host.id)
      .maybeSingle()
    if (error) throw error
    zone = await getLocationZone(db, anchor?.anchor_location_id || null)
  } catch (e) {
    logWarn('host-portal', 'anchor zone unreadable; using the default zone', { err: e })
    zone = DEFAULT_TZ
  }
  return { zone, today: todayIsoIn(zone) }
}

/** One race_events row, only if it belongs to hostId; null for missing, errored or another host's. */
export async function loadHostEvent(db, hostId, eventId, columns) {
  const { data, error } = await db.from('race_events').select(columns).eq('id', eventId).maybeSingle()
  if (error) {
    logWarn('host-portal', 'event read failed', { err: error, eventId })
    return null
  }
  if (!data || data.host_id !== hostId) return null
  return data
}

const NEEDS_ACTION = new Set(['draft', 'rejected'])

/** Split a host's events into needsAction / upcoming (soonest first) / past (newest first). */
export function groupHostEvents(events, today) {
  const needsAction = []
  const upcoming = []
  const past = []
  for (const e of events || []) {
    if (e.race_date && e.race_date < today) past.push(e)
    else if (NEEDS_ACTION.has(e.status)) needsAction.push(e)
    else upcoming.push(e)
  }
  const date = (e) => e.race_date || ''
  upcoming.sort((a, b) => date(a).localeCompare(date(b)))
  past.sort((a, b) => date(b).localeCompare(date(a)))
  return { needsAction, upcoming, past }
}

/** Where an event's row link goes: drafts and rejected events open the edit form. */
export function eventLandingHref(event) {
  return NEEDS_ACTION.has(event.status) ? `/host/events/${event.id}/edit` : `/host/events/${event.id}`
}

const PAGE = 1000

/**
 * Public ratings only, averaged to one decimal per event.
 * Map(eventId -> { average, count }); null when a read failed; empty map for no ids.
 */
export async function loadPublicRatingAverages(db, eventIds) {
  const ids = [...new Set((eventIds || []).filter(Boolean))]
  const out = new Map()
  if (ids.length === 0) return out
  const sums = new Map()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('event_ratings')
      .select('race_event_id, rating')
      .in('race_event_id', ids)
      .eq('is_public', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      logWarn('host-portal', 'rating averages read failed', { err: error })
      return null
    }
    const rows = Array.isArray(data) ? data : []
    for (const r of rows) {
      const n = Number(r.rating)
      if (!Number.isFinite(n)) continue
      const s = sums.get(r.race_event_id) || { sum: 0, count: 0 }
      s.sum += n
      s.count += 1
      sums.set(r.race_event_id, s)
    }
    if (rows.length < PAGE) break
  }
  for (const [id, s] of sums) out.set(id, { average: Number((s.sum / s.count).toFixed(1)), count: s.count })
  return out
}

/**
 * The three counts the Attendees tab and the Overview Bookings tile share:
 * bookings (every registration returned), confirmed, and people (a member-less
 * entry still counts as one).
 */
export function attendeeCounts(regs) {
  const list = Array.isArray(regs) ? regs : []
  const people = list.reduce((n, r) => {
    const members = Array.isArray(r?.teams?.team_members) ? r.teams.team_members : []
    return n + Math.max(1, members.length)
  }, 0)
  return { bookings: list.length, confirmed: list.filter((r) => r?.status === 'confirmed').length, people }
}
