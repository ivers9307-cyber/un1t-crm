// UN1TSYNC.3 — pure mappers from un1t.online API rows to the un1t_* mirror
// tables (mig 726). No I/O. Every mapper takes (apiRow, { locationId, now })
// and returns the DB row WITHOUT `id` and `contact_id` (the sync resolves the
// contact), or null when the row has no id.
//
// PII rule (plan global constraints): nothing here may emit
// reset_password_token / reset_password_expire / next_of_kin / guest_name /
// guest_email / guest_phone / invoice_url or an embedded `user` object. Client
// rows get NO raw payload at all (un1t_clients keeps derived counters only);
// every other table's `raw` is the API row minus STRIPPED_KEYS, removed at
// EVERY depth (an embedded object or array element included: UN1THARD.3),
// and a transaction's raw also drops `description` (free text a studio can
// fill with anything about the payer).

import { normalizeEmail } from './email-inbox.js'
import { normalizePhone } from './glofox-sync.js'

/** Subscription statuses that count as a live membership. */
export const MEMBERSHIP_ACTIVE_STATUSES = Object.freeze(['active', 'trialing', 'past_due'])

const STRIPPED_KEYS = Object.freeze([
  'user',
  'guest_name',
  'guest_email',
  'guest_phone',
  'invoice_url',
  'reset_password_token',
  'reset_password_expire',
  'next_of_kin',
])

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function hasId(row) {
  return isObj(row) && row.id !== undefined && row.id !== null && row.id !== ''
}

function text(v) {
  if (v === undefined || v === null) return null
  const s = String(v)
  return s === '' ? null : s
}

function int(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(v)
}

function bool(v) {
  return typeof v === 'boolean' ? v : null
}

function ts(v) {
  return typeof v === 'string' && v !== '' ? v : null
}

function nonEmpty(v) {
  return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null
}

// Deep enough for every shape seen (embedded product / subscription.product);
// anything deeper is dropped rather than copied unchecked.
const MAX_RAW_DEPTH = 6

function stripDeep(v, drop, depth) {
  if (Array.isArray(v)) return depth >= MAX_RAW_DEPTH ? [] : v.map((x) => stripDeep(x, drop, depth + 1))
  if (!isObj(v)) return v
  if (depth >= MAX_RAW_DEPTH) return {}
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (!drop.includes(k)) out[k] = stripDeep(x, drop, depth + 1)
  }
  return out
}

/** The API row minus STRIPPED_KEYS (and `extra`) at every depth. */
function rawOf(row, extra = []) {
  return stripDeep(row, extra.length ? [...STRIPPED_KEYS, ...extra] : STRIPPED_KEYS, 0)
}

/** Keys dropped from a transaction's raw on top of STRIPPED_KEYS. */
export const TRANSACTION_RAW_DROP = Object.freeze(['description'])

/** un1t_clients row. Derived counters only; no raw (client rows are PII). */
export function mapClient(row, ctx) {
  if (!hasId(row)) return null
  const ledger = isObj(row.credit_ledger) ? row.credit_ledger : {}
  const b30 = isObj(row.bookings_30d) ? row.bookings_30d : {}
  return {
    location_id: ctx.locationId,
    un1t_user_id: String(row.id),
    status: text(row.status),
    credit_balance: int(ledger.balance),
    credit_unlimited: bool(ledger.is_unlimited),
    last_attended_at: ts(row.last_attended_at),
    bookings_30d_attended: int(b30.attended),
    bookings_30d_no_show: int(b30.no_show),
    ltv_cents: int(row.ltv),
    remote_created_at: ts(row.created_at),
    remote_updated_at: ts(row.updated_at),
    synced_at: ctx.now,
  }
}

/** The contact-side fields a client row can fill. Email/phone are normalised. */
export function contactFieldsFromClient(row) {
  const r = isObj(row) ? row : {}
  return {
    // normalizeEmail trims, lowercases and rejects unstorable addresses.
    email: normalizeEmail(r.email),
    first_name: text(typeof r.first_name === 'string' ? r.first_name.trim() : r.first_name),
    last_name: text(typeof r.last_name === 'string' ? r.last_name.trim() : r.last_name),
    phone: normalizePhone(r.phone),
  }
}

export function mapProduct(row, ctx) {
  if (!hasId(row)) return null
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    title: text(row.title),
    type: text(row.type),
    status: text(row.status),
    visibility: text(row.visibility),
    price_cents: int(row.price_amount),
    currency: text(row.price_currency),
    billing_interval: text(row.billing_interval),
    billing_interval_count: int(row.billing_interval_count),
    credits_per_period: int(row.credits_per_period),
    raw: rawOf(row),
    synced_at: ctx.now,
  }
}

export function mapSubscription(row, ctx) {
  if (!hasId(row)) return null
  const p = isObj(row.product) ? row.product : {}
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    un1t_user_id: text(row.user_id ?? (isObj(row.user) ? row.user.id : undefined)),
    product_id: text(row.product_id ?? p.id),
    product_title: text(p.title),
    status: text(row.status),
    price_cents: int(p.price_amount),
    currency: text(p.price_currency),
    billing_interval: text(p.billing_interval),
    billing_interval_count: int(p.billing_interval_count),
    credits_per_period: int(row.credits_per_period),
    current_period_start: ts(row.current_period_start),
    current_period_end: ts(row.current_period_end),
    cancel_at_period_end: bool(row.cancel_at_period_end),
    trial_end: ts(row.trial_end),
    paused_at: ts(row.paused_at),
    paused_until: ts(row.paused_until),
    past_due_at: ts(row.past_due_at),
    remote_created_at: ts(row.created_at),
    remote_updated_at: ts(row.updated_at),
    raw: rawOf(row),
    synced_at: ctx.now,
  }
}

export function mapTransaction(row, ctx) {
  if (!hasId(row)) return null
  const p = isObj(row.product) ? row.product : {}
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    un1t_user_id: text(row.user_id ?? (isObj(row.user) ? row.user.id : undefined)),
    product_id: text(row.product_id ?? p.id),
    product_title: text(p.title),
    invoice_id: text(row.invoice_id),
    type: text(row.type),
    product_type: text(row.product_type),
    amount_cents: int(row.amount),
    currency: text(row.currency),
    refunded: bool(row.refunded),
    refund_status: text(row.refund_status),
    remote_created_at: ts(row.created_at),
    raw: rawOf(row, TRANSACTION_RAW_DROP),
    synced_at: ctx.now,
  }
}

export function mapInvoice(row, ctx) {
  if (!hasId(row)) return null
  const sub = isObj(row.subscription) ? row.subscription : {}
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    un1t_user_id: text(row.user_id ?? (isObj(row.user) ? row.user.id : undefined)),
    subscription_id: text(row.subscription_id ?? sub.id),
    status: text(row.status),
    amount_cents: int(row.amount),
    currency: text(row.currency),
    remote_created_at: ts(row.created_at),
    raw: rawOf(row),
    synced_at: ctx.now,
  }
}

export function mapEvent(row, ctx) {
  if (!hasId(row)) return null
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    title: text(row.title),
    status: text(row.status),
    access_mode: text(row.access_mode),
    is_free: bool(row.is_free),
    starts_at: ts(row.start_time),
    ends_at: ts(row.end_time),
    capacity: int(row.clients_limit),
    bookings_count: int(row.bookings_count),
    series_id: text(row.series_id),
    raw: rawOf(row),
    synced_at: ctx.now,
  }
}

export function mapBooking(row, ctx) {
  if (!hasId(row)) return null
  return {
    location_id: ctx.locationId,
    un1t_id: String(row.id),
    un1t_user_id: text(row.user_id ?? (isObj(row.user) ? row.user.id : undefined)),
    event_id: text(row.event_id),
    status: text(row.status),
    source: text(row.source),
    credit_charged: bool(row.credit_charged),
    has_guest: nonEmpty(row.guest_name) || nonEmpty(row.guest_email) || nonEmpty(row.guest_phone),
    external_member_ref: text(row.external_member_ref),
    external_booking_ref: text(row.external_booking_ref),
    remote_created_at: ts(row.created_at),
    remote_updated_at: ts(row.updated_at),
    raw: rawOf(row),
    synced_at: ctx.now,
  }
}

/**
 * The studio a row belongs to: `studio.id` on a client row, `studio_id` on
 * every other kind. null when absent.
 * @param {'client'|'product'|'subscription'|'transaction'|'invoice'|'event'|'booking'} kind
 */
export function rowStudioId(kind, row) {
  if (!isObj(row)) return null
  const v = kind === 'client' ? row.studio?.id : row.studio_id
  return text(v)
}
