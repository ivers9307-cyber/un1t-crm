// MIAGIVING.1 — past events that are still taking raffle entries or donations.
//
// list_upcoming_events reads future events at the conversation's own studio.
// A charity day's raffle and donation page stay open after the day, and giving
// is not tied to a studio the way a class is, so this read is organisation
// wide: it is the `still_giving` list beside the tool's `events`.
//
// What qualifies (the design is
// docs/superpowers/specs/2026-11-23-mia-giving-links-design.md):
//   - a UN1T event (no host), active and published, with charity switched on
//     (the public page shows neither the donate card nor the raffle card
//     without it), dated today or earlier on its own studio's clock (today is
//     the day most people ask, and another studio's event is in no one's
//     upcoming list), and
//   - when it is in the past, its sign-up is closed: the public page judges
//     sign-up by its opening and closing times only, never the event's date,
//     so a past event with sign-up left open would offer a paid entry; and either
//   - its raffle sells online right now (the public page's own rule,
//     onlineSalesState), or
//   - donations are switched on and the event was within GIVING_WINDOW_DAYS.
//     A donation page never closes by itself, so the window is ours.
//
// Scoping: the organisation is read from the thread's studio, then every read
// is by a location id that belongs to it. Nothing internal leaves this file:
// no id, total, ticket number, price or buyer.
//
// A failed read is "unknown", never "nothing open": `unreadable` is true.
import { onlineSalesState } from '@/lib/raffle-online'
import { RAFFLE_COLS } from '@/lib/raffle'
import { zoneOfLocation, todayStrIn, addDaysISO } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { dateLabel } from './event-date-label'
import { dateTimeLabel } from './offer-view'

export const GIVING_WINDOW_DAYS = 30
const MAX_ENTRIES = 6
// One .in() of event ids follows this read: 150 is the house cap for one.
const MAX_EVENTS_READ = 150
const LOG_MODULE = 'mia-giving'
const EVENT_COLUMNS = 'id, name, slug, race_date, location_id, host_id, active, status, charity_enabled, charity, registration_closes_at'
const LOCATION_COLUMNS = 'id, name, timezone, active, is_host_anchor'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Would the public page still take an entry for this event? Its own rule: the closing time or the charity's sign-up switch. */
function signupClosed(event, nowMs) {
  if (event.charity?.signup_off === true) return true
  const closes = event.registration_closes_at ? Date.parse(event.registration_closes_at) : NaN
  return Number.isFinite(closes) && closes <= nowMs
}

/**
 * One past event as Mia sees it, or null when nothing of it is open. Pure.
 * @param {{ event: object, raffle: object|null, location: object, threadLocationId: string, baseUrl: string, nowMs: number }} args
 */
export function givingEntry({ event, raffle = null, location, threadLocationId, baseUrl, nowMs = Date.now() }) {
  if (!event || event.host_id || event.active !== true || event.status !== 'published') return null
  // The public event page builds its raffle card only beside the charity block.
  if (event.charity_enabled !== true) return null
  const date = str(event.race_date)
  if (!date || !str(event.slug)) return null
  const zone = zoneOfLocation(location)
  const today = todayStrIn(zone, nowMs)
  if (date > today) return null
  if (date < today && !signupClosed(event, nowMs)) return null
  // The page's raffle is the one filed under the event's own studio (loadRaffleForEvent).
  const raffleOpen = Boolean(raffle) && raffle.location_id === event.location_id && onlineSalesState(raffle, nowMs).open
  const donationsOpen = date >= addDaysISO(today, -GIVING_WINDOW_DAYS)
  if (!raffleOpen && !donationsOpen) return null
  return {
    name: str(event.name) || 'Event',
    studio: location?.name || '',
    this_conversation: event.location_id === threadLocationId,
    date: dateLabel(date),
    charity: str(event.charity?.name),
    raffle_open: raffleOpen,
    raffle_closes_label: raffleOpen && raffle.online_closes_at ? dateTimeLabel(raffle.online_closes_at, zone) : null,
    donations_open: donationsOpen,
    url: `${baseUrl}/event/${event.slug}`,
  }
}

const UNKNOWN = Object.freeze({ entries: [], unreadable: true })

/**
 * Every past event in the thread studio's organisation that still takes
 * raffle entries or donations, the thread's studio first, then most recent.
 * Never throws.
 * @param {object} db service-role client
 * @param {{ threadLocationId: string, nowMs?: number, excludeEventIds?: string[], baseUrlFor?: (db: object, locationId: string) => Promise<string> }} opts
 * @returns {Promise<{ entries: object[], unreadable: boolean }>}
 */
export async function readStillGiving(db, { threadLocationId, nowMs = Date.now(), excludeEventIds = [], baseUrlFor } = {}) {
  if (!db || !threadLocationId) return { ...UNKNOWN }
  try {
    const { data: own, error: ownErr } = await db.from('locations').select('organization_id').eq('id', threadLocationId).maybeSingle()
    if (ownErr || !own?.organization_id) {
      logWarn(LOG_MODULE, 'thread studio unreadable', { locationId: threadLocationId, code: ownErr?.code ?? null })
      return { ...UNKNOWN }
    }
    const { data: locs, error: locErr } = await db.from('locations').select(LOCATION_COLUMNS)
      .eq('organization_id', own.organization_id).order('name', { ascending: true })
    if (locErr) {
      logWarn(LOG_MODULE, 'studios unreadable', { code: locErr.code ?? null })
      return { ...UNKNOWN }
    }
    const locations = new Map((locs || []).filter((l) => l.active !== false && l.is_host_anchor !== true).map((l) => [l.id, l]))
    if (locations.size === 0) return { entries: [], unreadable: false }

    // The latest "today" across the studios bounds the read; givingEntry
    // judges each event on its own studio's clock.
    const latestToday = [...locations.values()].map((l) => todayStrIn(zoneOfLocation(l), nowMs)).sort().pop()
    const { data: events, error: evErr } = await db.from('race_events').select(EVENT_COLUMNS)
      .in('location_id', [...locations.keys()])
      .is('host_id', null)
      .eq('active', true)
      .eq('status', 'published')
      .eq('charity_enabled', true)
      .lte('race_date', latestToday)
      .order('race_date', { ascending: false })
      .limit(MAX_EVENTS_READ)
    if (evErr) {
      logWarn(LOG_MODULE, 'events unreadable', { code: evErr.code ?? null })
      return { ...UNKNOWN }
    }
    if (!events?.length) return { entries: [], unreadable: false }

    let unreadable = false
    const raffleByEvent = new Map()
    const { data: raffles, error: rafErr } = await db.from('raffles').select(RAFFLE_COLS)
      .in('race_event_id', events.map((e) => e.id))
      .in('location_id', [...locations.keys()])
    if (rafErr) {
      // Donations still qualify an event; what a raffle would add is unknown.
      unreadable = true
      logWarn(LOG_MODULE, 'raffles unreadable', { code: rafErr.code ?? null })
    } else {
      for (const r of raffles || []) raffleByEvent.set(r.race_event_id, r)
    }

    const resolveBase = baseUrlFor || (async (d, id) => (await import('@/lib/tenant-host')).resolveCustomerBaseUrl(d, id))
    const bases = new Map()
    const found = []
    const excluded = new Set(excludeEventIds || [])
    for (const event of events) {
      const location = locations.get(event.location_id)
      if (!location || excluded.has(event.id)) continue
      // Decide first with a placeholder host, so a studio with nothing open costs no host read.
      if (!givingEntry({ event, raffle: raffleByEvent.get(event.id) || null, location, threadLocationId, baseUrl: '', nowMs })) continue
      if (!bases.has(location.id)) bases.set(location.id, await resolveBase(db, location.id))
      found.push({
        raceDate: event.race_date,
        entry: givingEntry({ event, raffle: raffleByEvent.get(event.id) || null, location, threadLocationId, baseUrl: bases.get(location.id), nowMs }),
      })
    }
    found.sort((a, b) => Number(b.entry.this_conversation) - Number(a.entry.this_conversation)
      || String(b.raceDate).localeCompare(String(a.raceDate)))
    return { entries: found.slice(0, MAX_ENTRIES).map((f) => f.entry), unreadable }
  } catch (err) {
    logWarn(LOG_MODULE, 'still giving read threw', { errClass: err?.name })
    return { ...UNKNOWN }
  }
}
