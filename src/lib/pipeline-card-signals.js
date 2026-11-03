// HATCHCARD.1 — what a un1t.online board's card says about the person, so a
// coach can see who to call without opening every contact.
//
// Measured on Hatch Street (2 Nov 2026, 194 accounts old enough to have had a
// chance to buy): reaching the THIRD class is the predictor (46% bought,
// against 12–22% below it), buyers buy within ~2 days of a class (median), and
// non-buyers last trained ~19 days ago (median). So a card shows classes done,
// credits left, the next booked class (or none), how long since the last
// class, and whether the person has ever answered on WhatsApp.
//
// Every input is the BOARD STUDIO's own: its un1t.online bookings
// (class_bookings with source_platform 'un1t_online'), its un1t_clients rows
// and its WhatsApp threads. Never contacts.recent_bookings or
// contacts.trial_credits_remaining, which are Glofox's (another studio's, for a
// dual-studio contact; HATCHPIPE.5). WhatsApp: on a thread, window_open_at is
// the customer's last inbound message (verified: 29 of 29 Hatch threads with a
// reply, and no inbound without it), last_message_at the newest either way.
//
// Day counts are derived on the SERVER (like the age footer, PIPE-AGE.1) so
// SSR and hydration render the same text.

import { getBoardModule } from '../../shared/pipelines/index.js'
import { shapeTrialWindow } from '@/lib/membership/reads/un1t-online-shape'
import { paidTrialProductIdsFor } from '@/lib/paid-trial-products'
import { dayStrIn } from '@/lib/location-time'

const DAY_MS = 86_400_000
/** Past this many days since the last class, the card's last-class chip turns amber. */
export const LAST_CLASS_WARM_DAYS = 7
/** Contacts per .in() read: keeps each request URL well inside PostgREST's limit. */
export const SIGNAL_CONTACT_CHUNK = 200
/** PostgREST's row cap: each chunk is read in .range() pages of this size. */
export const SIGNAL_READ_PAGE = 1000

// The columns where a card carries signals (one list, shared with DealCard).
export { SIGNAL_SLUGS } from './pipeline-card-signal-slugs.js'

/** Only a board whose inputs are un1t.online carries signals (Glofox boards keep their own badges). */
export function cardSignalsEnabledForModule(moduleName) {
  return getBoardModule(moduleName)?.inputSource === 'un1t_online'
}

const msOf = (v) => {
  if (v == null) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
const daysSince = (ms, nowMs) => (ms == null ? null : Math.max(0, Math.floor((nowMs - ms) / DAY_MS)))
const upper = (v) => String(v ?? '').trim().toUpperCase()
const isAttended = (b) => b?.attended === true || upper(b?.status) === 'ATTENDED'
// REBOOK.1 — how a booking ended without the class, for the card's "missed" chip.
const MISSED_OUTCOME = Object.freeze({ CANCELLED: 'cancelled', LATE_CANCELLED: 'late cancel', NO_SHOW: 'no-show' })

/**
 * One person's signals. Pure; reads no clock but `nowMs`.
 * @param {{ bookings?: object[], clients?: object[], conversations?: object[], nowMs: number }} a
 */
// HATCHCARD.4 — whole calendar days from one instant's date to another's in
// `zone` (date arithmetic on YYYY-MM-DD parts, never a re-zoned instant).
function calendarDaysBetween(fromMs, toMs, zone) {
  const a = dayStrIn(new Date(fromMs), zone).split('-').map(Number)
  const b = dayStrIn(new Date(toMs), zone).split('-').map(Number)
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY_MS)
}

export function shapeCardSignals({ bookings = [], clients = [], conversations = [], trialWindow = null, zone = null, nowMs } = {}) {
  let classesAttended = 0
  let lastClassMs = null
  let nextClassMs = null
  let nextClassAt = null
  let missed = null
  for (const b of bookings) {
    if (!b) continue
    const at = msOf(b.starts_at)
    // REBOOK.1 — the newest booking that ended without the class: cancelled,
    // a no-show, or a start that passed with nothing recorded.
    const status = upper(b.status)
    const outcome = isAttended(b) ? null
      : MISSED_OUTCOME[status] ?? (at != null && at <= nowMs ? 'not attended' : null)
    if (outcome && at != null && (missed == null || at > missed.ms)) {
      missed = { ms: at, class_name: b.class_name ? String(b.class_name) : null, starts_at: b.starts_at, outcome }
    }
    if (isAttended(b)) {
      classesAttended++
      if (at != null && at <= nowMs && (lastClassMs == null || at > lastClassMs)) lastClassMs = at
    } else if (upper(b.status) === 'BOOKED' && at != null && at > nowMs && (nextClassMs == null || at < nextClassMs)) {
      nextClassMs = at
      nextClassAt = b.starts_at
    }
  }

  let unlimited = false
  let credits = null
  for (const c of clients) {
    if (!c) continue
    if (c.credit_unlimited === true) unlimited = true
    const n = Number(c.credit_balance)
    if (c.credit_balance != null && Number.isFinite(n)) credits = (credits ?? 0) + Math.max(0, n)
  }

  let replyMs = null
  let lastMessageMs = null
  let anyThread = false
  for (const w of conversations) {
    if (!w) continue
    anyThread = true
    const r = msOf(w.window_open_at)
    if (r != null && (replyMs == null || r > replyMs)) replyMs = r
    const l = msOf(w.last_message_at)
    if (l != null && (lastMessageMs == null || l > lastMessageMs)) lastMessageMs = l
  }
  const waState = !anyThread ? 'never' : replyMs != null ? 'replied' : 'no_reply'

  const lastClassDays = daysSince(lastClassMs, nowMs)
  // REBOOK.1 — shown only when it is the latest news: a class they came to
  // after it, or a live booking ahead, makes the miss history.
  const missedIsLatest = missed && (lastClassMs == null || missed.ms > lastClassMs) && nextClassMs == null

  // HATCHCARD.2 — the trial window (shapeTrialWindow): days left while it
  // runs (rounded up: half a day left reads as 1), days since it ended after.
  const endsMs = msOf(trialWindow?.ends_at)
  // HATCHCARD.4 — with the studio zone, CALENDAR days in that zone, so the
  // count agrees with the date the card prints (0 = ends later today).
  // Without one, elapsed time (rounded up while it runs).
  const live = endsMs != null && endsMs > nowMs
  const ended = endsMs != null && endsMs <= nowMs
  const trialDaysLeft = !live ? null
    : zone ? calendarDaysBetween(nowMs, endsMs, zone) : Math.ceil((endsMs - nowMs) / DAY_MS)
  const trialEndedDays = !ended ? null
    : zone ? calendarDaysBetween(endsMs, nowMs, zone) : daysSince(endsMs, nowMs)

  return {
    classes_attended: classesAttended,
    credits_left: unlimited ? null : credits,
    credits_unlimited: unlimited,
    next_class_at: nextClassAt,
    last_class_days: lastClassDays,
    last_class_warm: lastClassDays != null && lastClassDays > LAST_CLASS_WARM_DAYS,
    wa_state: waState,
    wa_days: waState === 'replied' ? daysSince(replyMs, nowMs) : waState === 'no_reply' ? daysSince(lastMessageMs, nowMs) : null,
    trial_kind: trialWindow?.kind ?? null,
    trial_ends_at: endsMs != null ? trialWindow.ends_at : null,
    trial_days_left: trialDaysLeft,
    trial_ended_days: trialEndedDays,
    missed_class: missedIsLatest ? { class_name: missed.class_name, starts_at: missed.starts_at, outcome: missed.outcome } : null,
  }
}

// Read every row of one table for one chunk of contact ids, in ordered
// .range() pages under the 1,000-row cap. Resolves { rows } or { error }.
async function readChunk(build, ids) {
  const rows = []
  for (let from = 0; ; from += SIGNAL_READ_PAGE) {
    const { data, error } = await build(ids).range(from, from + SIGNAL_READ_PAGE - 1)
    if (error) return { error }
    rows.push(...(data || []))
    if (!data || data.length < SIGNAL_READ_PAGE) return { rows }
  }
}

async function readAll(build, contactIds) {
  const rows = []
  for (let i = 0; i < contactIds.length; i += SIGNAL_CONTACT_CHUNK) {
    const res = await readChunk(build, contactIds.slice(i, i + SIGNAL_CONTACT_CHUNK))
    if (res.error) return { error: res.error }
    rows.push(...res.rows)
  }
  return { rows }
}

const groupBy = (rows) => {
  const m = new Map()
  for (const r of rows) {
    if (!r?.contact_id) continue
    if (!m.has(r.contact_id)) m.set(r.contact_id, [])
    m.get(r.contact_id).push(r)
  }
  return m
}

/**
 * The signals of every listed contact at one un1t.online studio.
 * Resolves { signals: Map<contactId, signals> } with an entry for EVERY id
 * asked for, or { error } when any read failed: a failed read is never "nothing
 * known", which would print "0 of 3 classes" and "Never messaged" on everyone.
 * The caller decides what a failure means for its page (the board renders its
 * cards without signals).
 *
 * @param {object} db service-role client
 * @param {{ locationId: string, contactIds: string[], nowMs?: number }} a
 */
export async function loadUn1tCardSignals(db, { locationId, contactIds, nowMs = Date.now(), zone = null }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (ids.length === 0) return { signals: new Map() }

  // HATCHCARD.2 — the studio's paid-trial product set (throws on a failed
  // read: "could not read" must never become "no paid trials") and products,
  // for the trial window.
  let paidTrialProductIds
  try {
    paidTrialProductIds = await paidTrialProductIdsFor(db, locationId)
  } catch (e) {
    return { error: e }
  }
  const productsRes = await readChunk(() => db.from('un1t_products')
    .select('un1t_id, type, price_cents, credits_per_period, title, expire_credits_in_days:raw->>expire_credits_in_days')
    .eq('location_id', locationId)
    .order('un1t_id'), null)
  if (productsRes.error) return { error: productsRes.error }
  const productsById = new Map(productsRes.rows.map((p) => [p.un1t_id, p]))

  const [bookings, clients, conversations, transactions] = await Promise.all([
    readAll((chunk) => db.from('class_bookings')
      .select('id, contact_id, class_name, starts_at, status, attended')
      .eq('location_id', locationId)
      .eq('source_platform', 'un1t_online')
      .in('contact_id', chunk)
      .order('starts_at', { ascending: true })
      .order('id'), ids),
    readAll((chunk) => db.from('un1t_clients')
      .select('id, contact_id, credit_balance, credit_unlimited')
      .eq('location_id', locationId)
      .in('contact_id', chunk)
      .order('id'), ids),
    readAll((chunk) => db.from('whatsapp_conversations')
      .select('id, contact_id, window_open_at, last_message_at')
      .eq('location_id', locationId)
      .in('contact_id', chunk)
      .order('id'), ids),
    readAll((chunk) => db.from('un1t_transactions')
      .select('id, contact_id, product_id, amount_cents, refunded, remote_created_at, type, product_type')
      .eq('location_id', locationId)
      .in('contact_id', chunk)
      .order('remote_created_at', { ascending: true })
      .order('id'), ids),
  ])
  const failed = bookings.error || clients.error || conversations.error || transactions.error
  if (failed) return { error: failed }

  const byBooking = groupBy(bookings.rows)
  const byClient = groupBy(clients.rows)
  const byThread = groupBy(conversations.rows)
  const byTx = groupBy(transactions.rows)
  const signals = new Map()
  for (const id of ids) {
    signals.set(id, shapeCardSignals({
      bookings: byBooking.get(id) || [],
      clients: byClient.get(id) || [],
      conversations: byThread.get(id) || [],
      trialWindow: shapeTrialWindow({ transactions: byTx.get(id) || [], productsById, paidTrialProductIds }),
      zone,
      nowMs,
    }))
  }
  return { signals }
}
