// UN1TRADAR.1 — the un1t.online radar reads (spec B §2): the I/O half of
// ./un1t-online-radar-shape.js. Registered on un1tOnlineReads as
// radarMembers / winbackContacts / leadContacts.
//
//   radarMembers(db, L, { nowMs })     → Row[]      the churn radar's active base
//   winbackContacts(db, L, { nowMs })  → Row[]      live rows + ex-members
//   leadContacts(db, L, { nowMs })     → LeadRow[]  spec A's snapshot, lead-radar shaped
//   radarPastDue(db, L, { nowMs })     → fetchPastDue's shape, from spec A's pastDue (UN1TRADAR.2)
//   arrears(db, L)                     → fetchArrearsSummary's { success, data } (+ estimated)
//
// Each THROWS on any failed read (a radar that cannot read is a 500, never an
// empty radar). SCOPE: every un1t_* and contact_memberships query filters
// `location_id = L`, the studio the MEMBERSHIP is held at, so a contact owned
// by Stillorgan with a Hatch membership counts at Hatch. `contacts` is read BY
// ID for the people those rows link to (name; and for leads email, phone,
// lead_source), plus, for leads only, the contacts L itself owns. Service-role
// client; reads only. Every list read is selectAll paginated with an explicit
// order; `.in()` lists are chunked (event ids at 200, contact ids at 300).
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { logInfo } from '@/lib/log'
import { MEMBER_STATUSES } from './un1t-online-shape'
// un1t-online.js registers these reads, so this import is a cycle: safe, because
// both sides only touch the other's bindings at CALL time (and these are
// hoisted function declarations).
import { freshCutoff, un1tOnlineReads } from './un1t-online'
import { shapeRadarMembers, shapeWinbackRows, shapeLeadRows, foldPastDue, arrearsFromFold } from './un1t-online-radar-shape'

const PAGE = 1000
const EVENT_CHUNK = 200
const CONTACT_CHUNK = 300
const WINDOW_30D_MS = 30 * 86_400_000
const STATUS_SOURCES = Object.freeze(['un1t_online_api', 'un1t_online_export'])

const SUB_COLS = 'un1t_id, un1t_user_id, contact_id, status, product_id, product_title, price_cents, billing_interval, billing_interval_count, current_period_end, cancel_at_period_end, paused_at, paused_until, past_due_at, remote_created_at, synced_at'
const CLIENT_COLS = 'un1t_user_id, contact_id, credit_balance, credit_unlimited, last_attended_at, bookings_30d_attended, bookings_30d_no_show, ltv_cents, remote_created_at'
const PACK_TX_COLS = 'un1t_user_id, product_id, product_type, product_title, amount_cents, remote_created_at'
const PAYMENT_COLS = 'un1t_user_id, amount_cents, refunded, remote_created_at'
const PRODUCT_COLS = 'un1t_id, type, price_cents, title'
const EVENT_COLS = 'un1t_id, starts_at'
const BOOKING_COLS = 'un1t_user_id, event_id, status'
const BOOKED_AT_COLS = 'un1t_user_id, contact_id, remote_created_at'
const ENDED_COLS = 'contact_id, plan_name, ended_at'
const LEAD_CONTACT_COLS = 'id, name, email, phone, lead_source, joined_at, created_at'

// selectAll stops SILENTLY at its hard cap; a radar that read a truncated
// table would be wrong without saying so, so reaching the cap is a failure.
const HARD_CAP = 50_000

/**
 * Every row of `table` at L, `build(q)` adding filters; paginated, ordered by
 * id. Throws on a failed page and when the hard cap is reached.
 */
async function listAt(db, loc, table, cols, build = (q) => q) {
  const rows = await selectAll((from, to) => build(db
    .from(table)
    .select(cols)
    .eq('location_id', loc))
    .order('id', { ascending: true })
    .range(from, to), { pageSize: PAGE, hardCap: HARD_CAP })
  if (rows.length >= HARD_CAP) throw new Error(`${table}: ${HARD_CAP} rows at one studio; refusing a truncated radar`)
  return rows
}

/** The un1t_subscriptions freshness cutoff (see freshCutoff in ./un1t-online.js). */
const subsCutoff = (db, loc) => freshCutoff(db, 'un1t_subscriptions', loc)

const latestBy = (rows, keyOf, atOf) => {
  const out = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    const at = atOf(r)
    if (k == null || !Number.isFinite(Date.parse(at))) continue
    if (!out.has(k) || Date.parse(at) > Date.parse(out.get(k))) out.set(k, at)
  }
  return out
}

const contactsByIds = async (db, ids, cols) => {
  const rows = await selectAllByKeys(
    [...new Set(ids.filter((id) => id != null))],
    (keys, from, to) => db.from('contacts').select(cols).in('id', keys).order('id', { ascending: true }).range(from, to),
    { chunkSize: CONTACT_CHUNK, pageSize: PAGE },
  )
  return new Map(rows.map((c) => [c.id, c]))
}

/** Everything shapeRadarMembers needs, given the subscriptions to use. */
async function loadRadarInputs(db, loc, nowMs, subs) {
  const fromIso = new Date(nowMs - WINDOW_30D_MS).toISOString()
  const toIso = new Date(nowMs).toISOString()
  const [clients, packTxs, products, payments, events, bookedAt] = await Promise.all([
    listAt(db, loc, 'un1t_clients', CLIENT_COLS),
    listAt(db, loc, 'un1t_transactions', PACK_TX_COLS, (q) => q.eq('product_type', 'pack')),
    listAt(db, loc, 'un1t_products', PRODUCT_COLS),
    listAt(db, loc, 'un1t_transactions', PAYMENT_COLS, (q) => q.in('type', ['sub_initial', 'sub_renewal']).gt('amount_cents', 0)),
    listAt(db, loc, 'un1t_events', EVENT_COLS, (q) => q.gte('starts_at', fromIso).lte('starts_at', toIso)),
    listAt(db, loc, 'un1t_bookings', BOOKED_AT_COLS),
  ])
  const bookings = await selectAllByKeys(
    [...new Set(events.map((e) => e.un1t_id).filter((id) => id != null))],
    (keys, from, to) => db
      .from('un1t_bookings')
      .select(BOOKING_COLS)
      .eq('location_id', loc)
      .in('event_id', keys)
      .order('id', { ascending: true })
      .range(from, to),
    { chunkSize: EVENT_CHUNK, pageSize: PAGE },
  )
  const contactIds = [...clients.map((c) => c.contact_id), ...subs.map((s) => s.contact_id)]
  const contactsById = await contactsByIds(db, contactIds, 'id, name')
  return {
    subs,
    clients,
    packTxs,
    products,
    contactsById,
    events,
    bookings,
    newestBookingAtByUser: latestBy(bookedAt, (b) => b.un1t_user_id, (b) => b.remote_created_at),
    lastPaymentAtByUser: latestBy(payments.filter((t) => t.refunded !== true), (t) => t.un1t_user_id, (t) => t.remote_created_at),
    nowMs,
  }
}

/** Fresh live subscriptions at L (status in MEMBER_STATUSES, synced in the latest pull). */
async function listFreshLiveSubs(db, loc) {
  const cutoffIso = await subsCutoff(db, loc)
  if (cutoffIso === null) return []
  return listAt(db, loc, 'un1t_subscriptions', SUB_COLS, (q) => q.in('status', MEMBER_STATUSES).gte('synced_at', cutoffIso))
}

/** The churn radar's active base at L, in the scorer's row shape. Throws on a failed read. */
export async function radarMembers(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) throw new Error('No location')
  const subs = await listFreshLiveSubs(db, locationId)
  const input = await loadRadarInputs(db, locationId, nowMs, subs)
  const out = shapeRadarMembers(input)
  logInfo('churn-radar', 'un1t radar built', {
    locationId, members: out.members, packHolders: out.packHolders, unlinkedClients: out.unlinkedClients, pinned: 0,
  })
  return out.rows
}

/** Live rows plus ex-members at L (see shapeWinbackRows). Throws on a failed read. */
export async function winbackContacts(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) throw new Error('No location')
  const [freshCutoffIso, allSubs, endedMemberships] = await Promise.all([
    subsCutoff(db, locationId),
    listAt(db, locationId, 'un1t_subscriptions', SUB_COLS),
    listAt(db, locationId, 'contact_memberships', ENDED_COLS, (q) => q.in('source', STATUS_SOURCES).eq('status', 'ended')),
  ])
  const input = await loadRadarInputs(db, locationId, nowMs, allSubs)
  // name for ex-members linked only through an ended membership row
  const missing = endedMemberships.map((m) => m.contact_id).filter((id) => id != null && !input.contactsById.has(id))
  if (missing.length) for (const [id, c] of await contactsByIds(db, missing, 'id, name')) input.contactsById.set(id, c)
  return shapeWinbackRows({ ...input, allSubs, freshCutoffIso, endedMemberships })
}

/**
 * Lead rows at L from spec A's pipeline snapshot (pipelineInputs), plus the
 * contacts L owns with no linked un1t client in it. Throws when
 * pipelineInputs answers success:false or any read fails.
 */
export async function leadContacts(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) throw new Error('No location')
  const pipe = await un1tOnlineReads.pipelineInputs(db, locationId, { now: nowMs })
  if (!pipe?.success) throw new Error(pipe?.error || 'pipelineInputs failed')
  const pipeline = pipe.data
  const inPipeline = new Set(pipeline.contacts.map((c) => c.id))
  const [contactsById, owned, clients, bookedAt] = await Promise.all([
    contactsByIds(db, [...inPipeline], LEAD_CONTACT_COLS),
    selectAll((from, to) => db
      .from('contacts')
      .select(LEAD_CONTACT_COLS)
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, to), { pageSize: PAGE }),
    listAt(db, locationId, 'un1t_clients', 'un1t_user_id, contact_id'),
    listAt(db, locationId, 'un1t_bookings', BOOKED_AT_COLS),
  ])
  const contactOfUser = new Map(clients.filter((c) => c.contact_id != null).map((c) => [c.un1t_user_id, c.contact_id]))
  const clientContacts = new Set(contactOfUser.values())
  const newestBookingAtByContact = latestBy(
    bookedAt,
    (b) => (b.un1t_user_id != null ? contactOfUser.get(b.un1t_user_id) : null) ?? b.contact_id ?? null,
    (b) => b.remote_created_at,
  )
  return shapeLeadRows({
    pipeline,
    contactsById,
    // spec §2c: owned contacts with NO un1t_clients row here (fresh or stale);
    // a stale client is an account un1t.online dropped, not a new lead
    ownedWithoutClient: owned.filter((c) => !inPipeline.has(c.id) && !clientContacts.has(c.id)),
    newestBookingAtByContact,
  })
}

const ID_CHUNK = 200

/**
 * UN1TRADAR.2 — fetchPastDue's shape at a un1t.online studio, folded from spec
 * A's `pastDue` (never re-derived here). Reads the past-due subscriptions'
 * prices (for an unreported amount) and the members' last attendance, both at
 * L. Throws on `success:false` or a failed read: never "nobody owes".
 */
export async function radarPastDue(db, locationId, { nowMs: _nowMs = Date.now() } = {}) {
  if (!locationId) throw new Error('No location')
  const res = await un1tOnlineReads.pastDue(db, locationId)
  if (!res?.success) throw new Error(res?.error || 'pastDue failed')
  const rows = res.data || []
  const subIds = [...new Set(rows.map((r) => r.subscriptionId).filter((v) => v != null))]
  const userIds = [...new Set(rows.map((r) => r.un1tUserId).filter((v) => v != null))]
  const byKeys = (table, cols, column, keys) => selectAllByKeys(
    keys,
    (chunk, from, to) => db.from(table).select(cols).eq('location_id', locationId).in(column, chunk)
      .order('id', { ascending: true }).range(from, to),
    { chunkSize: ID_CHUNK, pageSize: PAGE },
  )
  const [subs, clients] = await Promise.all([
    byKeys('un1t_subscriptions', 'un1t_id, price_cents', 'un1t_id', subIds),
    byKeys('un1t_clients', 'un1t_user_id, last_attended_at', 'un1t_user_id', userIds),
  ])
  return foldPastDue(rows, {
    priceBySubscriptionId: new Map(subs.map((s) => [s.un1t_id, s.price_cents])),
    lastAttendedByUser: new Map(clients.map((c) => [c.un1t_user_id, c.last_attended_at])),
  })
}

/**
 * UN1TRADAR.2 — the business "In arrears" figure (fetchArrearsSummary's
 * envelope): `{ success, data: { totalCents, memberCount, estimated } }`, built
 * on the same fold as the Overdue tab, so the two agree. `estimated` is true
 * when any amount was un1t.online's unreported one (the card says so).
 */
export async function arrears(db, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  try {
    return { success: true, data: arrearsFromFold(await radarPastDue(db, locationId)) }
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) }
  }
}
