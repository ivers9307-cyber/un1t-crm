// MIAHATCH.2 — the four member reads at a un1t.online studio (Hatch Street):
// get_my_membership, get_my_next_class, list_my_upcoming_bookings and
// get_my_recent_attendance, answered from the un1t_* mirror (mig 726) and,
// for bookings, from a live per-member read first.
//
// Called only on a turn whose tool block starts with `un1t_` (ctx.turn.block,
// set by the runner); a Glofox-only turn never reaches this file, so nothing
// here can touch a un1t table, the un1t reader or the Glofox executors'
// behaviour. The dispatch in executeAccountTool / executeBookingTool loads this
// module lazily for that reason.
//
// Rules this file keeps:
// - Verified turns only (the caller's `not_verified` object otherwise).
// - Which un1t.online account: the answerable studio's `un1tUserId`, never a
//   guess. A studio without one answers "no account found".
// - Two answerable studios: `{ studios: [{ studio: name, ...shape }] }`, the
//   Glofox section produced by TODAY's executor (turn removed so it does not
//   re-route) with the Glofox studio as the location.
// - Bookings: live first; any failure (a spent budget included), or a list the
//   page cap cut, falls back to / is topped up from the mirror and carries
//   `may_be_stale: true`.
// - A failed read is `read_failed`, never "no membership" or "nothing booked".
// - Nothing the model sees carries capacity, spaces left or a headcount.
import { formatClassTime } from './dublin-format'
import { DEFAULT_TZ, formatInZone, getLocationZone } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { MEMBERSHIP_ACTIVE_STATUSES } from '@/lib/un1t-online-map'
import { providerFor } from '@/lib/membership/source'
import { chunkIds } from '@/lib/person-accounts'
import { fetchLiveUn1tBookings } from './un1t-member-read'
import { tagUn1tId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO } from './tool-capability'

const LOG_MODULE = 'mia-un1t'

// Values read from the live un1t.online data (17-18 Oct 2026, read-only):
// un1t_bookings.status is one of booked / attended / cancelled / no_show;
// un1t_products.status is 'active' on every row, visibility public / private.
export const UN1T_BOOKED_STATUS = 'booked'
export const UN1T_PRODUCT_ACTIVE_STATUS = 'active'
export const UN1T_PRODUCT_PRIVATE_VISIBILITY = 'private'

export const UN1T_READ_TOOL_NAMES = Object.freeze(new Set([
  'get_my_membership',
  'get_my_next_class',
  'list_my_upcoming_bookings',
  'get_my_recent_attendance',
]))

const MAX_MEMBER_BOOKINGS = 10
const PAGE = 1000
const MAX_MIRROR_ROWS = 5000

export const UN1T_NO_7_DAY_NOTE = 'no 7-day count at this studio; never state one'

const NOT_VERIFIED = Object.freeze({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
const READ_FAILED = Object.freeze({
  error: 'read_failed',
  message: 'That could not be looked up just now. Do not guess. Say you could not check it right now and offer to hand off to the team.',
})
const LIST_FAILED = Object.freeze({
  error: 'list_failed',
  message: 'Could not load their bookings just now, offer to hand off.',
})
const LIST_FAILED_TIMETABLE = Object.freeze({
  error: 'list_failed',
  message: 'Could not load the timetable just now, offer to hand off.',
})
const NO_ACCOUNT_NOTE =
  'No account was found for this person at this studio. Say you cannot see an account for them here and offer to hand off to the team.'
const STALE_NOTE =
  'This comes from synced data that can be a few minutes behind. Relay it, and say a very recent booking or cancellation may not show yet.'

// ── pure shapers ────────────────────────────────────────────────────

const toMs = (v) => {
  const ms = Date.parse(v || '')
  return Number.isFinite(ms) ? ms : null
}

/** "Fri 20 Nov 2026" in the studio's zone, or null for an unparseable instant. Pure. */
function dateLabel(iso, zone) {
  const ms = toMs(iso)
  if (ms === null) return null
  return formatInZone(ms, zone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

const INTERVAL_WORDS = Object.freeze({ day: 'day', week: 'week', month: 'month', year: 'year' })

/**
 * "€125" for a one-off, "€189 a month" / "€500 every 3 months" for a recurring
 * price. null when there is no price. Pure.
 */
export function un1tPriceLabel({ price_cents, currency, billing_interval, billing_interval_count } = {}) {
  const cents = Number(price_cents)
  if (price_cents === null || price_cents === undefined || !Number.isFinite(cents) || cents < 0) return null
  const major = cents / 100
  const amount = Number.isInteger(major) ? String(major) : major.toFixed(2)
  const code = String(currency || 'eur').toLowerCase()
  const money = code === 'eur' ? `€${amount}` : `${code.toUpperCase()} ${amount}`
  const word = INTERVAL_WORDS[String(billing_interval || '').toLowerCase()]
  if (!word) return money
  const count = Number(billing_interval_count)
  return Number.isFinite(count) && count > 1 ? `${money} every ${count} ${word}s` : `${money} a ${word}`
}

function creditsOf(client, creditsCapable) {
  if (!creditsCapable || !client) return null
  if (client.credit_unlimited === true) return 'unlimited'
  const balance = Number(client.credit_balance)
  return client.credit_balance !== null && client.credit_balance !== undefined && Number.isFinite(balance) ? balance : null
}

/**
 * The membership the member holds at a un1t.online studio. The live
 * subscription is the one with the latest current_period_end among
 * MEMBERSHIP_ACTIVE_STATUSES. Status: `paused` when paused_until is in the
 * future, then `payment_issue` (past_due_at set, or the subscription itself
 * is past_due), then `ending` (cancel_at_period_end), else `active`; `none`
 * when no subscription is live. `renews_on` is set for `active` only, so a
 * paused, ending or past-due membership never promises a renewal. Plan name,
 * price and interval come from the subscription (what the member pays) and
 * fall back to its product. `credits` is null unless `creditsCapable`. Pure.
 *
 * @param {{ subscriptions?: object[], productsById?: Record<string, object>|Map<string, object>,
 *   client?: object|null, creditsCapable?: boolean, zone?: string, nowMs?: number }} args
 */
export function shapeUn1tMembership({ subscriptions, productsById, client, creditsCapable, zone = DEFAULT_TZ, nowMs = Date.now() } = {}) {
  const credits = creditsOf(client, creditsCapable === true)
  const live = (Array.isArray(subscriptions) ? subscriptions : [])
    .filter((s) => s && MEMBERSHIP_ACTIVE_STATUSES.includes(s.status))
    .sort((a, b) => (toMs(b.current_period_end) ?? -Infinity) - (toMs(a.current_period_end) ?? -Infinity))
  const sub = live[0]
  if (!sub) return { status: 'none', plan: null, price_label: null, renews_on: null, credits }

  const product = productsById instanceof Map ? productsById.get(sub.product_id) : productsById?.[sub.product_id]
  const plan = String(sub.product_title || product?.title || '').trim() || null
  const price_label = un1tPriceLabel({
    price_cents: sub.price_cents ?? product?.price_cents,
    currency: sub.currency ?? product?.currency,
    billing_interval: sub.billing_interval ?? product?.billing_interval,
    billing_interval_count: sub.billing_interval_count ?? product?.billing_interval_count,
  })
  const periodEnd = dateLabel(sub.current_period_end, zone)
  const base = { plan, price_label, renews_on: null, credits }

  const pausedUntilMs = toMs(sub.paused_until)
  if (pausedUntilMs !== null && pausedUntilMs > nowMs) {
    return { status: 'paused', ...base, paused_until: dateLabel(sub.paused_until, zone) }
  }
  if (sub.past_due_at || sub.status === 'past_due') return { status: 'payment_issue', ...base }
  if (sub.cancel_at_period_end === true) return { status: 'ending', ...base, ends_on: periodEnd }
  return { status: 'active', ...base, renews_on: periodEnd }
}

const eventStartMs = (e) => toMs(e?.starts_at)

/**
 * A member's future booked classes from booking rows (live API rows carry `id`,
 * mirror rows `un1t_id`) joined to events by the event's un1t id. Only rows
 * with status 'booked' and a start after `nowMs`, soonest first, at most 10,
 * ids tagged `un1t:`. Rows whose event has no known start are dropped (the
 * caller flags those as stale). Pure.
 *
 * @param {object[]} rows
 * @param {Record<string, { title?: string, starts_at?: string }>|Map<string, object>} eventsByUn1tId
 * @param {number} nowMs
 * @param {string} [zone]
 * @returns {{ booking_id: string, class_name: string, starts_at: string }[]}
 */
export function shapeUn1tBookingsForAgent(rows, eventsByUn1tId, nowMs, zone = DEFAULT_TZ) {
  const eventOf = (id) => (eventsByUn1tId instanceof Map ? eventsByUn1tId.get(id) : eventsByUn1tId?.[id])
  const out = []
  const seen = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || String(r.status || '').toLowerCase() !== UN1T_BOOKED_STATUS) continue
    const id = rowId(r)
    const eventId = rowEventId(r)
    if (!id || !eventId || seen.has(id)) continue
    const event = eventOf(eventId)
    const startMs = eventStartMs(event)
    if (startMs === null || startMs <= nowMs) continue
    seen.add(id)
    out.push({
      startMs,
      booking_id: tagUn1tId(id),
      class_name: String(event?.title || '').trim() || 'Class',
      starts_at: formatClassTime(Math.floor(startMs / 1000), zone),
    })
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out.slice(0, MAX_MEMBER_BOOKINGS).map(({ startMs: _omitted, ...rest }) => rest)
}

/**
 * The timetable for a un1t block: `{ event_id: 'un1t:<un1t_id>', name,
 * starts_at, full }` per class, starts_at the studio's wall-clock label.
 * `full` is `capacity > 0 && bookings_count >= capacity` (a null or 0 capacity
 * is never full). CAPACITY-SECRECY.1: capacity and bookings_count are read
 * here to compute `full` and go no further; they are in no returned object.
 * Rows without an id or a parseable start are dropped. Pure.
 */
export function shapeUn1tTimetableForAgent(rows, zone = DEFAULT_TZ) {
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = rowId(r)
    const ms = toMs(r?.starts_at)
    if (!id || ms === null) continue
    const capacity = Number(r.capacity)
    const booked = Number(r.bookings_count) || 0
    out.push({
      event_id: tagUn1tId(id),
      name: String(r?.title || '').trim() || 'Class',
      starts_at: formatClassTime(Math.floor(ms / 1000), zone),
      full: Number.isFinite(capacity) && capacity > 0 && booked >= capacity,
    })
  }
  return out
}

/**
 * Attendance from the client counters. No 7-day figure exists at this studio
 * (the note says so, the model never states one) and no-shows are left out. Pure.
 */
export function shapeUn1tAttendance(client, zone = DEFAULT_TZ) {
  const base = { total_attended_7d: null, note: UN1T_NO_7_DAY_NOTE }
  if (!client) return { found: false, ...base }
  const count = Number(client.bookings_30d_attended)
  return {
    found: true,
    total_attended_30d: Number.isFinite(count) ? count : 0,
    last_attended_on: dateLabel(client.last_attended_at, zone),
    ...base,
  }
}

function rowId(r) {
  const v = r?.un1t_id ?? r?.id
  return v === null || v === undefined || v === '' ? null : String(v)
}
function rowEventId(r) {
  const v = r?.event_id ?? (r?.event && typeof r.event === 'object' ? r.event.id : undefined)
  return v === null || v === undefined || v === '' ? null : String(v)
}

// ── IO ──────────────────────────────────────────────────────────────

function logReadError(op, studio, error) {
  logWarn(LOG_MODULE, 'mirror read failed', { locationId: studio.locationId, op, code: error?.code ?? null })
}

/** Page through a mirror select so the 1,000-row cap never truncates it. */
async function readAllRows(build) {
  const rows = []
  for (let from = 0; from < MAX_MIRROR_ROWS; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) return { error }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return { rows }
}

/** un1t_events rows for a set of event un1t ids at one studio, keyed by id. */
async function readEvents(db, studio, eventIds, { futureFromIso = null, op }) {
  const byId = new Map()
  for (const batch of chunkIds(eventIds)) {
    let q = db.from('un1t_events')
      .select('un1t_id, title, starts_at, status')
      .eq('location_id', studio.locationId)
      .in('un1t_id', batch)
    if (futureFromIso) q = q.gte('starts_at', futureFromIso)
    const { data, error } = await q
    if (error) {
      logReadError(op, studio, error)
      return { error }
    }
    for (const e of data || []) byId.set(String(e.un1t_id), e)
  }
  return { byId }
}

/** The mirror's future booked rows for this member, with their events. */
async function readMirrorBookings(db, studio, nowMs) {
  const { rows, error } = await readAllRows(() => db.from('un1t_bookings')
    .select('un1t_id, event_id, status')
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', studio.un1tUserId)
    .eq('status', UN1T_BOOKED_STATUS)
    .order('un1t_id'))
  if (error) {
    logReadError('bookings_mirror', studio, error)
    return { error }
  }
  const eventIds = [...new Set(rows.map(rowEventId).filter(Boolean))]
  const { byId, error: eventsError } = await readEvents(db, studio, eventIds, { futureFromIso: new Date(nowMs).toISOString(), op: 'events_mirror' })
  if (eventsError) return { error: eventsError }
  return { rows, byId }
}

/**
 * The member's upcoming booked classes at one un1t.online studio.
 * Live read first; the mirror when the live read fails, and to top up a list
 * the page cap cut. `staleBecause` is set whenever the answer leans on the
 * mirror or an event the mirror does not know yet.
 *
 * @returns {Promise<{ bookings: object[], may_be_stale: boolean } | { error: true }>}
 */
async function loadUn1tBookings(db, studio, nowMs, zone) {
  let live = null
  try {
    live = await fetchLiveUn1tBookings(db, { locationId: studio.locationId, un1tUserId: studio.un1tUserId })
  } catch (err) {
    logWarn(LOG_MODULE, 'live bookings read threw', { locationId: studio.locationId, op: 'bookings', status: null, errClass: err?.name })
    live = { ok: false, reason: 'read_failed' }
  }

  if (!live?.ok) {
    const mirror = await readMirrorBookings(db, studio, nowMs)
    if (mirror.error) return { error: true }
    return { bookings: shapeUn1tBookingsForAgent(mirror.rows, mirror.byId, nowMs, zone), may_be_stale: true }
  }

  const liveBooked = live.rows.filter((r) => r && String(r.status || '').toLowerCase() === UN1T_BOOKED_STATUS)
  const eventIds = [...new Set(liveBooked.map(rowEventId).filter(Boolean))]
  const events = await readEvents(db, studio, eventIds, { op: 'events_live' })
  const byId = events.byId ?? new Map()
  // The live row may carry its own event; use it for an event the mirror has
  // not synced yet.
  let unresolved = 0
  for (const r of liveBooked) {
    const eventId = rowEventId(r)
    if (!eventId || byId.has(eventId)) continue
    const embedded = r.event && typeof r.event === 'object' ? r.event : null
    const startsAt = embedded?.starts_at ?? embedded?.start_time
    if (toMs(startsAt) !== null) byId.set(eventId, { title: embedded.title, starts_at: startsAt })
    else unresolved += 1
  }
  if (events.error && unresolved > 0 && byId.size === 0) return { error: true }

  let rows = liveBooked
  let stale = Boolean(events.error) || unresolved > 0
  if (live.truncated) {
    // The live list may be incomplete: add the mirror's future booked rows
    // for events the live list did not name.
    stale = true
    const mirror = await readMirrorBookings(db, studio, nowMs)
    if (!mirror.error) {
      const liveEvents = new Set(liveBooked.map(rowEventId).filter(Boolean))
      const extra = mirror.rows.filter((r) => !liveEvents.has(rowEventId(r)))
      rows = [...liveBooked, ...extra]
      for (const [id, e] of mirror.byId) if (!byId.has(id)) byId.set(id, e)
    }
  }
  return { bookings: shapeUn1tBookingsForAgent(rows, byId, nowMs, zone), may_be_stale: stale }
}

async function readMembership(db, studio, zone) {
  const noAccount = !studio.un1tUserId
  if (noAccount) {
    return { ...shapeUn1tMembership({ subscriptions: [], client: null, creditsCapable: false, zone }), account_found: false, message: NO_ACCOUNT_NOTE }
  }
  const { data: subs, error: subsError } = await db.from('un1t_subscriptions')
    .select('status, product_id, product_title, price_cents, currency, billing_interval, billing_interval_count, current_period_end, cancel_at_period_end, paused_at, paused_until, past_due_at')
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', studio.un1tUserId)
    .order('un1t_id')
  if (subsError) {
    logReadError('membership', studio, subsError)
    return { ...READ_FAILED }
  }
  const { data: client, error: clientError } = await db.from('un1t_clients')
    .select('credit_balance, credit_unlimited')
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', studio.un1tUserId)
    .maybeSingle()
  if (clientError) logReadError('membership_client', studio, clientError)

  const productIds = [...new Set((subs || []).map((s) => s.product_id).filter(Boolean))]
  const productsById = new Map()
  if (productIds.length) {
    const { data: products, error: productsError } = await db.from('un1t_products')
      .select('un1t_id, title, price_cents, currency, billing_interval, billing_interval_count')
      .eq('location_id', studio.locationId)
      .in('un1t_id', productIds)
    // Not fatal: the subscription row carries its own title and price.
    if (productsError) logReadError('membership_products', studio, productsError)
    for (const p of products || []) productsById.set(String(p.un1t_id), p)
  }

  // Whether credits are reported follows the studio source's own capability.
  const creditsCapable = providerFor('un1t_online').capabilities?.credits === true
  const shaped = shapeUn1tMembership({ subscriptions: subs || [], productsById, client: clientError ? null : client, creditsCapable, zone })
  // With the client unreadable, "no membership" could hide a credit pack.
  if (clientError && shaped.status === 'none') return { ...READ_FAILED }
  return shaped
}

async function readAttendance(db, studio, zone) {
  if (!studio.un1tUserId) return { ...shapeUn1tAttendance(null, zone), account_found: false, message: NO_ACCOUNT_NOTE }
  const { data, error } = await db.from('un1t_clients')
    .select('bookings_30d_attended, last_attended_at')
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', studio.un1tUserId)
    .maybeSingle()
  if (error) {
    logReadError('attendance', studio, error)
    return { ...READ_FAILED }
  }
  return shapeUn1tAttendance(data, zone)
}

async function readBookingsTool(toolName, db, studio, zone) {
  if (!studio.un1tUserId) {
    return toolName === 'get_my_next_class'
      ? { found: false, account_found: false, message: NO_ACCOUNT_NOTE }
      : { bookings: [], account_found: false, message: NO_ACCOUNT_NOTE }
  }
  const nowMs = Date.now()
  const res = await loadUn1tBookings(db, studio, nowMs, zone)
  if (res.error) return toolName === 'get_my_next_class' ? { ...READ_FAILED } : { ...LIST_FAILED }
  const stale = res.may_be_stale ? { may_be_stale: true } : {}
  if (toolName === 'get_my_next_class') {
    const next = res.bookings[0]
    if (!next) return { found: false, ...stale, ...(res.may_be_stale ? { message: STALE_NOTE } : {}) }
    return { found: true, class_name: next.class_name, class_time: next.starts_at, booking_id: next.booking_id, ...stale, ...(res.may_be_stale ? { message: STALE_NOTE } : {}) }
  }
  if (!res.bookings.length) {
    return { bookings: [], ...stale, message: res.may_be_stale ? `No upcoming bookings are showing. ${STALE_NOTE}` : 'No upcoming bookings found for this member.' }
  }
  return { bookings: res.bookings, ...stale, ...(res.may_be_stale ? { message: STALE_NOTE } : {}) }
}

async function un1tSection(toolName, ctx, studio, zone) {
  const { db } = ctx
  if (toolName === 'get_my_membership') return readMembership(db, studio, zone)
  if (toolName === 'get_my_recent_attendance') return readAttendance(db, studio, zone)
  return readBookingsTool(toolName, db, studio, zone)
}

/** The studio's own zone: the thread's when it is the thread studio, else its location row's. */
async function zoneFor(ctx, studio) {
  const threadZone = ctx.zone || DEFAULT_TZ
  if (!studio.locationId || studio.locationId === ctx.locationId) return threadZone
  try {
    return await getLocationZone(ctx.db, studio.locationId)
  } catch (err) {
    logWarn(LOG_MODULE, 'studio zone unreadable; using the thread zone', { locationId: studio.locationId, errClass: err?.name })
    return threadZone
  }
}

// TODAY's executor for the Glofox half of a two-studio answer: same code
// path, the Glofox studio as the location, no turn (so it does not re-route).
// Loaded lazily; both executors load this file lazily too.
async function glofoxSection(toolName, input, ctx, studio, zone) {
  const glofoxCtx = {
    ...ctx,
    turn: undefined,
    locationId: studio.locationId,
    zone,
    canBook: true,
    membershipSourceKey: 'glofox',
  }
  if (toolName === 'list_my_upcoming_bookings' || toolName === 'list_upcoming_classes') {
    const { executeBookingTool } = await import('./booking-tools')
    return executeBookingTool(toolName, input, glofoxCtx)
  }
  const { executeAccountTool } = await import('./account-tools')
  return executeAccountTool(toolName, input, glofoxCtx)
}

/**
 * Answer one of the four member reads for a verified member from the
 * answerable studios. One studio: that studio's shape. More than one:
 * `{ studios: [{ studio: name, ...shape }] }`, in the order given.
 *
 * @param {string} toolName
 * @param {object} input
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone, ...)
 * @param {import('./member-studios').MemberStudio[]} studios answerable studios
 */
export async function executeUn1tRead(toolName, input, ctx, studios) {
  if (!UN1T_READ_TOOL_NAMES.has(toolName)) return { error: 'unknown_tool', tool: toolName }
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  const list = (Array.isArray(studios) ? studios : [])
    .filter((s) => s && (s.providerKey === 'un1t_online' || s.providerKey === 'glofox'))
  if (!list.length) return { ...TOOL_NOT_AT_THIS_STUDIO }

  const sections = await Promise.all(list.map(async (studio) => {
    try {
      const zone = await zoneFor(ctx, studio)
      return studio.providerKey === 'glofox'
        ? await glofoxSection(toolName, input, ctx, studio, zone)
        : await un1tSection(toolName, ctx, studio, zone)
    } catch (err) {
      logWarn(LOG_MODULE, 'member read threw', { locationId: studio.locationId, op: toolName, status: null, errClass: err?.name })
      return { ...READ_FAILED }
    }
  }))
  if (list.length === 1) return sections[0]
  return { studios: list.map((studio, i) => ({ studio: studio.name, ...sections[i] })) }
}

/**
 * `list_upcoming_classes` on a un1t turn. The answerable un1t.online studio is
 * read, whichever studio the thread is at (a Hatch-only member on a Stillorgan
 * thread reads Hatch's timetable). One studio: its shape, `{ classes,
 * truncated? }`. Two: `{ studios: [{ studio: name, ...shape }] }` with the
 * Glofox section from TODAY's executor (Glofox studio as the location, no
 * turn). No verification, as today. A failed read is the no-booking handoff
 * for that section, never an empty list.
 *
 * @param {object} input
 * @param {object} ctx tool context
 * @param {import('./member-studios').MemberStudio[]} studios answerable studios
 */
export async function executeUn1tTimetable(input, ctx, studios) {
  const list = (Array.isArray(studios) ? studios : [])
    .filter((s) => s && (s.providerKey === 'un1t_online' || s.providerKey === 'glofox'))
  if (!list.some((s) => s.providerKey === 'un1t_online')) return { ...TOOL_NOT_AT_THIS_STUDIO }

  const { listUn1tOnlineClasses } = await import('./booking-tools')
  const sections = await Promise.all(list.map(async (studio) => {
    try {
      const zone = await zoneFor(ctx, studio)
      if (studio.providerKey === 'glofox') return await glofoxSection('list_upcoming_classes', input, ctx, studio, zone)
      return await listUn1tOnlineClasses(ctx.db, studio.locationId, zone, Date.now(), { withEventIds: true })
    } catch (err) {
      logWarn(LOG_MODULE, 'timetable read threw', { locationId: studio.locationId, op: 'list_upcoming_classes', status: null, errClass: err?.name })
      return { ...LIST_FAILED_TIMETABLE }
    }
  }))
  if (list.length === 1) return sections[0]
  return { studios: list.map((studio, i) => ({ studio: studio.name, ...sections[i] })) }
}
