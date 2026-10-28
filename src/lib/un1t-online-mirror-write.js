// UN1TWRITE.6 — the un1t_* mirror after a done un1t.online write (spec 6.3).
//
// Called by the write primitives (un1t-online-write-ops.js) after a `done`
// verdict, recovered ones included. It keeps the mirror the sync owns in step
// with what the CRM just did, so staff see the booking and the credits at once
// instead of after the next 15-minute sync.
//
// Rules:
// - Every row this module writes stamps crm_written_at = now. Mig 744's
//   trigger then keeps it against a sync upsert whose pull began before it.
//   That includes the credits refresh on un1t_clients.
// - A failed mirror write NEVER changes the write's verdict: it is logError
//   with ids (contract log fields only) and { ok: false }; the next sync
//   repairs the row. Nothing here throws for a database or read failure.
// - Never the membership facts on contact_studios (the sync owns them), never a row with nothing to
//   say: a booking row needs an id and a status, or it would write NULL over
//   the sync's columns.
// - book / cancel: un1t_bookings through mapBooking (cancel re-reads
//   GET /bookings/{id} first), then one GET /credits/ledgers/{userId}/{studioId}.
//   has_guest comes from the data: the write module's picked answer carries the
//   flag but no guest fields, and mapBooking would derive false from it.
//   Only the columns the source carried are written (a picked answer never
//   NULLs source / credit_charged / the external refs), raw only from the
//   cancel's full re-read, synced_at never (it is the sync's clock), and a
//   re-read that names another client is not written.
// - create_client: contacts.un1t_user_id only where it is null; a 23505 on the
//   organisation's unique index (another contact holds that user) is
//   conflict 'un1t_link_conflict', never an overwrite. Then the un1t_clients row
//   through mapClient.
// - book / cancel, then (UN1TWRITE.11, spec D 6.3 and spec C §7): one
//   class_bookings upsert on location_id,glofox_booking_id, built ONLY by C's
//   mapUn1tBookingToClassBooking from the same answer (writtenBy 'crm'), so
//   the coach's list and the dashboard see the change at once. Its
//   raw.un1t.updated_at is un1t.online's own updated_at from the answer, or
//   null: never the request time or our clock (C's tie-break compares
//   un1t.online's clock only; with null, the next sync pull of the same rank
//   replaces the row, and a terminal sync status always does). Same gate as
//   C's projection: only at a studio whose membership_source is
//   'un1t_online'. The event (title, starts_at) is this studio's un1t_events
//   row; the name is contacts.name (a failed name read writes the row
//   without member_name, so the stored name stands). With no contact id,
//   contact_id is left out, never NULL over the sync's link. An unknown
//   event or a status C does not project writes nothing: the next sync
//   projects the booking. Never an update or a delete.
// - move (UN1TMOVE.1): the moved booking as a book writes it (the same
//   un1t_bookings key, so its event_id moves; the same class_bookings key, so
//   the coach's list shows the new class at once), then the credits. When
//   un1t.online answered a NEW booking id, the old one is re-read and written
//   as a cancel's is, so the old class does not keep showing them booked.
// - checkout: nothing (no money has moved). trial: Task 10.

import { mapBooking, mapClient } from './un1t-online-map.js'
import { mapUn1tBookingToClassBooking } from './un1t-online-bookings.js'
import { logError, logInfo, logWarn } from './log'

const LOG_MODULE = 'un1t-online-write'
export const UN1T_LINK_CONFLICT = 'un1t_link_conflict'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const idText = (v) => ((typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim() : null)
const sameId = (a, b) => idText(a) != null && idText(a)?.toLowerCase() === idText(b)?.toLowerCase()
const hasText = (v) => typeof v === 'string' && v.trim() !== ''

// The contract log fields only (global constraints): ids and codes.
function meta({ locationId, op, ledgerId }, code) {
  const out = { locationId, op, code }
  if (ledgerId) out.ledgerId = ledgerId
  return out
}

/**
 * Bring the un1t_* mirror in step with a done write.
 *
 * @param {object} db service-role client
 * @param {{ op: 'book'|'cancel'|'move'|'create_client'|'trial'|'checkout', locationId: string,
 *   contactId?: string|null, un1tUserId?: string|null, studioId?: string|null,
 *   data?: object|null, requestedAt?: string|null, ledgerId?: string|null,
 *   fromBookingId?: string|null }} args
 *   fromBookingId: a move's original booking id (re-read when the answer names another).
 *   requestedAt (when the write was sent) is a NEW un1t_clients row's
 *   synced_at; a booking write never sets synced_at (the column default on
 *   insert, untouched on update). ledgerId only feeds log lines.
 * @param {{ read: (path: string) => Promise<object>, now?: () => Date }} deps
 *   read is the writer's budget-counted GET.
 * @returns {Promise<{ ok: boolean, conflict?: 'un1t_link_conflict', row?: object|null }>}
 *   book/cancel/move also return `row`, the un1t_bookings row built (null when
 *   there was nothing to write).
 */
export async function applyUn1tWriteToMirror(db, args, { read, now = () => new Date() } = {}) {
  const op = args?.op
  if (op === 'checkout') return { ok: true }
  if (op !== 'book' && op !== 'cancel' && op !== 'move' && op !== 'create_client' && op !== 'trial') {
    throw new TypeError(`applyUn1tWriteToMirror: unknown op '${op}'`)
  }
  if (!args.locationId) throw new TypeError('applyUn1tWriteToMirror: locationId is required')
  const stamp = now().toISOString()
  if (op === 'create_client') return mirrorCreate(db, args, stamp)
  if (op === 'trial') return mirrorTrial(db, args, { read, stamp })
  const out = await mirrorBooking(db, args, { read, stamp })
  if (op !== 'move') return out
  // A move answered with another booking id: the old booking's own read says
  // where it now stands (cancelled, most likely). Its credits were refreshed above.
  const fromId = idText(args.fromBookingId)
  const newId = idText(args.data?.id)
  if (!fromId || !newId || sameId(fromId, newId)) return out
  const old = await mirrorBooking(db, { ...args, op: 'cancel', data: { id: fromId } }, { read, stamp, credits: false })
  return { ...out, ok: out.ok && old.ok }
}

/**
 * UN1TWRITE.10 — a granted trial. `data` = { transactionId?, product? (the
 * live un1t.online product: title, type, price_currency), credits? (a
 * credits answer already read, so it is not read twice) }. A transaction id
 * inserts its un1t_transactions row (€0, crm_written_at; the next sync's
 * fuller row wins under the mig 744 rank trigger); every grant refreshes the
 * client's credits.
 */
async function mirrorTrial(db, args, { read, stamp }) {
  const { locationId, contactId, un1tUserId, data } = args
  let ok = true
  const txId = idText(data?.transactionId)
  if (txId) {
    const product = isObj(data?.product) ? data.product : {}
    const row = {
      location_id: locationId,
      un1t_id: txId,
      un1t_user_id: un1tUserId ?? null,
      contact_id: contactId ?? null,
      product_id: idText(args.productId) ?? idText(product.id),
      product_title: hasText(product.title) ? product.title.trim() : null,
      amount_cents: 0,
      currency: hasText(product.price_currency) ? product.price_currency.trim().toUpperCase() : null,
      type: 'one_time',
      product_type: hasText(product.type) ? product.type.trim() : null,
      raw: { source: 'crm_write' },
      crm_written_at: stamp,
    }
    try {
      const { error } = await db.from('un1t_transactions').insert(row)
      if (error && error.code !== '23505') {
        ok = false
        logError(LOG_MODULE, 'mirror: un1t_transactions insert failed', meta(args, error.code ?? null))
      }
    } catch {
      ok = false
      logError(LOG_MODULE, 'mirror: un1t_transactions insert threw', meta(args, 'threw'))
    }
  }
  const credited = await refreshCredits(db, args, { read, stamp, ledger: data?.credits })
  return { ok: ok && credited }
}

async function mirrorBooking(db, args, { read, stamp, credits = true }) {
  const { op, locationId, contactId, un1tUserId, data, requestedAt } = args
  if (typeof read !== 'function') throw new TypeError('applyUn1tWriteToMirror: read is required for a booking')
  let source = isObj(data) ? data : null
  // Only the booking's own full read may write raw; a picked answer never does.
  let fromReread = false
  let ok = true

  if (op === 'cancel') {
    // The cancel answer has no schema: the booking's own read is the truth.
    const id = idText(source?.id)
    try {
      const fresh = id ? await read(`/bookings/${encodeURIComponent(id)}`) : null
      const owner = isObj(fresh) ? fresh.user_id ?? (isObj(fresh.user) ? fresh.user.id : undefined) : undefined
      if (isObj(fresh) && sameId(fresh.id, id) && (owner == null || !un1tUserId || sameId(owner, un1tUserId))) {
        source = fresh
        fromReread = true
      } else {
        ok = false
        logError(LOG_MODULE, 'mirror: the cancel re-read did not describe the booking', meta(args, 'reread_mismatch'))
        source = null
      }
    } catch (err) {
      ok = false
      logError(LOG_MODULE, 'mirror: the cancel re-read failed; using the answer if it says enough', meta(args, err?.code ?? 'reread_failed'))
    }
  }

  let row = null
  if (source && idText(source.id) && hasText(source.status)) {
    try {
      row = bookingWrite(source, { locationId, requestedAt, stamp, fromReread })
      if (!row.un1t_user_id && un1tUserId) row.un1t_user_id = un1tUserId
      // Only a known contact: a NULL would undo the sync's own link.
      if (contactId) row.contact_id = contactId
      const { error } = await db.from('un1t_bookings').upsert(row, { onConflict: 'location_id,un1t_id' })
      if (error) {
        ok = false
        logError(LOG_MODULE, 'mirror: un1t_bookings write failed', meta(args, error.code ?? null))
      }
    } catch {
      ok = false
      logError(LOG_MODULE, 'mirror: un1t_bookings write threw', meta(args, 'threw'))
    }
  } else {
    // A failed cancel re-read has already said so.
    if (ok) logError(LOG_MODULE, 'mirror: no booking row to write; the next sync brings it', meta(args, 'no_booking_row'))
    ok = false
  }

  const credited = credits ? await refreshCredits(db, args, { read, stamp }) : true
  // UN1TWRITE.11: only when the booking row above had something to say.
  const projected = row ? await writeClassBooking(db, args, { source, row, stamp }) : true
  return { ok: ok && credited && projected, row }
}

/**
 * UN1TWRITE.11 — the class_bookings row for a done book or cancel, through
 * C's mapper. Returns false (logged, ids only) when a read or the write
 * failed; a skip (not a un1t.online studio, no event yet, a status C does
 * not project) is logged and returns true. The verdict never depends on it.
 */
async function writeClassBooking(db, args, { source, row, stamp }) {
  const { locationId, contactId } = args
  try {
    // The projection's own gate: un1t classes only where the timetable is un1t.online.
    const { data: loc, error: locError } = await db
      .from('locations')
      .select('membership_source')
      .eq('id', locationId)
      .maybeSingle()
    if (locError) {
      logError(LOG_MODULE, 'mirror: class_bookings not written, the studio could not be read', meta(args, locError.code ?? null))
      return false
    }
    if (loc?.membership_source !== 'un1t_online') {
      logInfo(LOG_MODULE, 'mirror: class_bookings not written, the studio is not a un1t.online studio', meta(args, 'not_un1t_online'))
      return true
    }

    const mapped = mapBooking(source, { locationId, now: stamp })
    const eventId = mapped.event_id
    // A skip, not a failure (the projection counts these as skipped_*): the
    // next sync projects the booking.
    if (!eventId) {
      logWarn(LOG_MODULE, 'mirror: class_bookings not written, the answer names no event; the next sync projects it', meta(args, 'no_event'))
      return true
    }
    const { data: event, error: eventError } = await db
      .from('un1t_events')
      .select('un1t_id, title, starts_at')
      .eq('location_id', locationId)
      .eq('un1t_id', eventId)
      .maybeSingle()
    if (eventError) {
      logError(LOG_MODULE, 'mirror: class_bookings not written, the event read failed', meta(args, eventError.code ?? null))
      return false
    }
    if (!event) {
      logWarn(LOG_MODULE, 'mirror: class_bookings not written, the studio holds no such event yet; the next sync projects it', meta(args, 'no_event'))
      return true
    }

    // undefined = the key is left out, so the stored name stands.
    let memberName
    if (contactId) {
      const { data: person, error: nameError } = await db.from('contacts').select('name').eq('id', contactId).maybeSingle()
      if (nameError) logWarn(LOG_MODULE, 'mirror: contact name unreadable; class_bookings written without member_name', meta(args, nameError.code ?? null))
      else memberName = person?.name ?? null
    }

    const bookingRow = { ...mapped, contact_id: contactId ?? null, has_guest: typeof row.has_guest === 'boolean' ? row.has_guest : null }
    const classRow = mapUn1tBookingToClassBooking(bookingRow, { locationId, event, memberName, nowIso: stamp, writtenBy: 'crm' })
    if (!classRow) {
      logWarn(LOG_MODULE, 'mirror: class_bookings not written, a status the projection does not carry', meta(args, 'unprojectable_status'))
      return true
    }
    // Only a known contact: a NULL would undo the sync's own link.
    if (!contactId) delete classRow.contact_id

    const { error } = await db.from('class_bookings').upsert(classRow, { onConflict: 'location_id,glofox_booking_id' })
    if (error) {
      logError(LOG_MODULE, 'mirror: class_bookings write failed', meta(args, error.code ?? null))
      return false
    }
    return true
  } catch {
    logError(LOG_MODULE, 'mirror: class_bookings write threw', meta(args, 'threw'))
    return false
  }
}

// mapBooking column → the source keys it is read from. A column the source
// did not carry (or carried as null) is left out of the upsert, so a picked
// answer never writes NULL over the sync's columns.
const BOOKING_COLUMN_SOURCES = Object.freeze({
  un1t_user_id: (s) => s.user_id ?? (isObj(s.user) ? s.user.id : null),
  event_id: (s) => s.event_id ?? (isObj(s.event) ? s.event.id : null),
  status: (s) => s.status,
  source: (s) => s.source,
  credit_charged: (s) => s.credit_charged,
  external_member_ref: (s) => s.external_member_ref,
  external_booking_ref: (s) => s.external_booking_ref,
  remote_created_at: (s) => s.created_at,
  remote_updated_at: (s) => s.updated_at,
})
const GUEST_KEYS = ['guest_name', 'guest_email', 'guest_phone']

/**
 * The un1t_bookings columns this write may set. Never synced_at: it is the
 * sync's clock, so an insert takes the column default and an update never
 * moves it (backwards or at all). raw only from a full re-read.
 */
function bookingWrite(source, { locationId, requestedAt, stamp, fromReread }) {
  const mapped = mapBooking(source, { locationId, now: requestedAt || stamp })
  const row = { location_id: mapped.location_id, un1t_id: mapped.un1t_id, crm_written_at: stamp }
  for (const [col, from] of Object.entries(BOOKING_COLUMN_SOURCES)) {
    const v = from(source)
    if (v !== undefined && v !== null && mapped[col] !== null) row[col] = mapped[col]
  }
  // The guest flag: the answer's own (the pick keeps it), else the guest fields of a full read.
  if (typeof source.has_guest === 'boolean') row.has_guest = source.has_guest
  else if (fromReread || GUEST_KEYS.some((k) => source[k] !== undefined)) row.has_guest = mapped.has_guest
  if (fromReread) row.raw = mapped.raw
  return row
}

// One GET /credits/ledgers/{userId}/{studioId} → un1t_clients credit columns.
async function refreshCredits(db, args, { read, stamp, ledger: given = undefined }) {
  const { locationId, un1tUserId, studioId } = args
  if (!un1tUserId || !studioId) {
    logError(LOG_MODULE, 'mirror: credits refresh needs the user and the studio', meta(args, 'credits_args_missing'))
    return false
  }
  let ledger = given
  if (ledger === undefined) {
    try {
      ledger = await read(`/credits/ledgers/${encodeURIComponent(un1tUserId)}/${encodeURIComponent(studioId)}`)
    } catch (err) {
      logError(LOG_MODULE, 'mirror: credits read failed', meta(args, err?.code ?? 'credits_read_failed'))
      return false
    }
  }
  const patch = { crm_written_at: stamp }
  const balance = isObj(ledger) && typeof ledger.balance === 'number' && Number.isFinite(ledger.balance) ? Math.round(ledger.balance) : null
  const unlimited = isObj(ledger) && typeof ledger.is_unlimited === 'boolean' ? ledger.is_unlimited : null
  if (balance == null && unlimited == null) {
    logError(LOG_MODULE, 'mirror: credits answer had no balance', meta(args, 'credits_unreadable'))
    return false
  }
  if (balance != null) patch.credit_balance = balance
  if (unlimited != null) patch.credit_unlimited = unlimited
  try {
    const { data, error } = await db
      .from('un1t_clients')
      .update(patch)
      .eq('location_id', locationId)
      .eq('un1t_user_id', un1tUserId)
      .select('id')
    if (error) {
      logError(LOG_MODULE, 'mirror: un1t_clients credits write failed', meta(args, error.code ?? null))
      return false
    }
    // No row yet: the sync has not brought this client; it brings the credits too.
    if (!data || data.length === 0) logInfo(LOG_MODULE, 'mirror: no client row to refresh yet', meta(args, 'no_client_row'))
    return true
  } catch {
    logError(LOG_MODULE, 'mirror: un1t_clients credits write threw', meta(args, 'threw'))
    return false
  }
}

async function mirrorCreate(db, args, stamp) {
  const { locationId, contactId, un1tUserId, requestedAt } = args
  const userId = idText(un1tUserId)
  if (!userId) {
    logError(LOG_MODULE, 'mirror: a created client without an id', meta(args, 'no_user_id'))
    return { ok: false }
  }
  let ok = true
  let conflict = null
  let linked = false

  if (contactId) {
    try {
      const { data, error } = await db
        .from('contacts')
        .update({ un1t_user_id: userId })
        .eq('id', contactId)
        .is('un1t_user_id', null)
        .select('id')
      if (error?.code === '23505') {
        conflict = UN1T_LINK_CONFLICT
      } else if (error) {
        ok = false
        logError(LOG_MODULE, 'mirror: contact link write failed', meta(args, error.code ?? null))
      } else if (data && data.length > 0) {
        linked = true
      } else {
        // The contact already holds a un1t.online user: this one is fine,
        // another one is a conflict for staff, never an overwrite.
        const { data: held, error: readError } = await db.from('contacts').select('un1t_user_id').eq('id', contactId).maybeSingle()
        if (readError) {
          ok = false
          logError(LOG_MODULE, 'mirror: contact link read failed', meta(args, readError.code ?? null))
        } else if (held && held.un1t_user_id === userId) {
          linked = true
        } else if (held) {
          conflict = UN1T_LINK_CONFLICT
        }
      }
    } catch {
      ok = false
      logError(LOG_MODULE, 'mirror: contact link threw', meta(args, 'threw'))
    }
    if (conflict) logWarn(LOG_MODULE, 'mirror: the un1t.online user is linked to another contact; not overwritten', meta(args, conflict))
  }

  try {
    const row = { ...mapClient({ id: userId }, { locationId, now: requestedAt || stamp }), crm_written_at: stamp }
    if (linked) row.contact_id = contactId
    const { error } = await db.from('un1t_clients').insert(row)
    // 23505: the sync already brought this client; its row stands.
    if (error && error.code !== '23505') {
      ok = false
      logError(LOG_MODULE, 'mirror: un1t_clients insert failed', meta(args, error.code ?? null))
    }
  } catch {
    ok = false
    logError(LOG_MODULE, 'mirror: un1t_clients insert threw', meta(args, 'threw'))
  }

  if (conflict) return { ok: false, conflict }
  return { ok }
}
