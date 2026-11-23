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
// no id, total, ticket number or buyer.
//
// MIAEVENTFACTS.1 — an entry also carries what the event says about itself
// (its description, the charity, the raffle's ticket prices as the public page
// sells them), and the same details ride on upcoming events (givingDetails).
// Mia made up how a raffle worked when all she had was "a raffle is open":
// what the page shows is what she is given, and nothing else is hers to say.
//
// A failed read is "unknown", never "nothing open": `unreadable` is true.
import { onlineSalesState, ONLINE_MAX_TICKETS } from '@/lib/raffle-online'
import { pricingUnits, optionLabel } from '@/lib/raffle-format'
import { RAFFLE_COLS } from '@/lib/raffle'
import { zoneOfLocation, todayStrIn, addDaysISO } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { dateLabel } from './event-date-label'
import { dateTimeLabel } from './offer-view'

export const GIVING_WINDOW_DAYS = 30
// An event's own description as Mia reads it. Real ones run to about 1,400
// characters; the first 200 left out what an entry includes.
export const MAX_EVENT_DESCRIPTION = 1500
const MAX_ENTRIES = 6
// One .in() of event ids follows this read: 150 is the house cap for one.
const MAX_EVENTS_READ = 150
const LOG_MODULE = 'mia-giving'
const EVENT_COLUMNS = 'id, name, slug, description, race_date, location_id, host_id, active, status, charity_enabled, charity, registration_closes_at'
const LOCATION_COLUMNS = 'id, name, timezone, active, is_host_anchor'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The event's own description on one line, at most MAX_EVENT_DESCRIPTION characters, or null. Pure. */
export function eventDescription(text) {
  const flat = str(String(text ?? '').replace(/\s+/g, ' '))
  if (!flat) return null
  return flat.length > MAX_EVENT_DESCRIPTION ? `${flat.slice(0, MAX_EVENT_DESCRIPTION - 1).trimEnd()}…` : flat
}

/**
 * What a raffle ticket costs, as the public card sells it: the single price,
 * then each bundle the card offers online ("1 for €1", "20 for €10"). Pure.
 */
export function raffleTicketLabels(raffle) {
  if (!raffle || !(Number(raffle.ticket_price_cents) > 0)) return []
  // optionLabel writes euro: another currency is never quoted as euro.
  if ((raffle.currency || 'EUR') !== 'EUR') return []
  return pricingUnits(raffle)
    .filter((u) => u.tickets <= ONLINE_MAX_TICKETS)
    .map((u) => optionLabel(u.tickets, u.price_cents))
}

/** The raffle part of an entry, or {} when the page sells no raffle for this event right now. */
function raffleFields(event, raffle, zone, nowMs) {
  // The page's raffle is the one filed under the event's own studio (loadRaffleForEvent).
  const open = Boolean(raffle) && raffle.location_id === event.location_id && onlineSalesState(raffle, nowMs).open
  if (!open) return {}
  return {
    raffle_open: true,
    raffle_tickets: raffleTicketLabels(raffle),
    raffle_closes_label: raffle.online_closes_at ? dateTimeLabel(raffle.online_closes_at, zone) : null,
  }
}

/**
 * The giving details of an UPCOMING event, as its public page shows them, or
 * null when the page shows neither the donate card nor the raffle card (a
 * host event, or charity switched off). Pure.
 * @param {{ event: object, raffle: object|null, zone: string, nowMs?: number }} args
 */
export function givingDetails({ event, raffle = null, zone, nowMs = Date.now() }) {
  if (!event || event.host_id || event.charity_enabled !== true) return null
  return { charity: str(event.charity?.name), donations_open: true, ...raffleFields(event, raffle, zone, nowMs) }
}

/**
 * The raffles of these events, by event id. Scoped to the events' own studios.
 * Never throws; a failed read is `unreadable`, never "no raffle".
 * @returns {Promise<{ byEvent: Map<string, object>, unreadable: boolean }>}
 */
export async function readEventRaffles(db, events) {
  const byEvent = new Map()
  const list = (Array.isArray(events) ? events : []).filter((e) => e?.id && e.location_id).slice(0, MAX_EVENTS_READ)
  if (!db || list.length === 0) return { byEvent, unreadable: false }
  try {
    const { data, error } = await db.from('raffles').select(RAFFLE_COLS)
      .in('race_event_id', list.map((e) => e.id))
      .in('location_id', [...new Set(list.map((e) => e.location_id))])
    if (error) {
      logWarn(LOG_MODULE, 'raffles unreadable', { code: error.code ?? null })
      return { byEvent, unreadable: true }
    }
    for (const r of data || []) byEvent.set(r.race_event_id, r)
    return { byEvent, unreadable: false }
  } catch (err) {
    logWarn(LOG_MODULE, 'raffle read threw', { errClass: err?.name })
    return { byEvent, unreadable: true }
  }
}

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
  // An event still to come is listed too: another studio's is in no one's
  // upcoming list, and this studio's is left out of it once sign-up is closed
  // or switched off. The caller excludes what it already lists.
  if (date < today && !signupClosed(event, nowMs)) return null
  const raffleNow = raffleFields(event, raffle, zone, nowMs)
  const raffleOpen = raffleNow.raffle_open === true
  const donationsOpen = date >= addDaysISO(today, -GIVING_WINDOW_DAYS)
  const when = date > today ? 'upcoming' : date === today ? 'today' : 'past'
  if (!raffleOpen && !donationsOpen) return null
  return {
    name: str(event.name) || 'Event',
    studio: location?.name || '',
    this_conversation: event.location_id === threadLocationId,
    date: dateLabel(date),
    when,
    description: eventDescription(event.description),
    charity: str(event.charity?.name),
    raffle_open: raffleOpen,
    raffle_tickets: raffleNow.raffle_tickets || [],
    raffle_closes_label: raffleNow.raffle_closes_label || null,
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

    const { data: events, error: evErr } = await db.from('race_events').select(EVENT_COLUMNS)
      .in('location_id', [...locations.keys()])
      .is('host_id', null)
      .eq('active', true)
      .eq('status', 'published')
      .eq('charity_enabled', true)
      .order('race_date', { ascending: false })
      .limit(MAX_EVENTS_READ)
    if (evErr) {
      logWarn(LOG_MODULE, 'events unreadable', { code: evErr.code ?? null })
      return { ...UNKNOWN }
    }
    if (!events?.length) return { entries: [], unreadable: false }

    // Donations still qualify an event when the raffle read fails; what a
    // raffle would add is then unknown.
    const { byEvent: raffleByEvent, unreadable } = await readEventRaffles(db, events)

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
