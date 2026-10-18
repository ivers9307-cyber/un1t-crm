// UN1TWRITE.6 — the un1t_* mirror after a done un1t.online write (spec 6.3).
//
// Called by the write primitives (un1t-online-write.js) after a `done`
// verdict, recovered ones included. It keeps the mirror the sync owns in step
// with what the CRM just did, so staff see the booking and the credits at once
// instead of after the next 15-minute sync.
//
// Rules:
// - Every row this module writes stamps crm_written_at = now. Mig 742's
//   trigger then keeps it against a sync upsert whose pull began before it.
//   That includes the credits refresh on un1t_clients.
// - A failed mirror write NEVER changes the write's verdict: it is logError
//   with ids (contract log fields only) and { ok: false }; the next sync
//   repairs the row. Nothing here throws for a database or read failure.
// - Never contact_memberships (the sync owns it), never a row with nothing to
//   say: a booking row needs an id and a status, or it would write NULL over
//   the sync's columns.
// - book / cancel: un1t_bookings through mapBooking (cancel re-reads
//   GET /bookings/{id} first), then one GET /credits/ledgers/{userId}/{studioId}.
//   has_guest comes from the data: the write module's picked answer carries the
//   flag but no guest fields, and mapBooking would derive false from it.
// - create_client: contacts.un1t_user_id only where it is null; a 23505 on the
//   organisation's unique index (another contact holds that user) is
//   conflict 'un1t_link_conflict', never an overwrite. Then the un1t_clients row
//   through mapClient.
// - checkout: nothing (no money has moved). trial: Task 10.
// (The class_bookings write-through is Task 11.)

import { mapBooking, mapClient } from './un1t-online-map.js'
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
 * @param {{ op: 'book'|'cancel'|'create_client'|'trial'|'checkout', locationId: string,
 *   contactId?: string|null, un1tUserId?: string|null, studioId?: string|null,
 *   data?: object|null, requestedAt?: string|null, ledgerId?: string|null }} args
 *   requestedAt (when the write was sent) is the row's synced_at: the data is
 *   as of then. ledgerId only feeds log lines.
 * @param {{ read: (path: string) => Promise<object>, now?: () => Date }} deps
 *   read is the writer's budget-counted GET.
 * @returns {Promise<{ ok: boolean, conflict?: 'un1t_link_conflict', row?: object|null }>}
 *   book/cancel also return `row`, the un1t_bookings row built (null when
 *   there was nothing to write).
 */
export async function applyUn1tWriteToMirror(db, args, { read, now = () => new Date() } = {}) {
  const op = args?.op
  if (op === 'checkout') return { ok: true }
  if (op === 'trial') throw new TypeError('applyUn1tWriteToMirror: the trial mirror arrives with grantTrial (Task 10)')
  if (op !== 'book' && op !== 'cancel' && op !== 'create_client') {
    throw new TypeError(`applyUn1tWriteToMirror: unknown op '${op}'`)
  }
  if (!args.locationId) throw new TypeError('applyUn1tWriteToMirror: locationId is required')
  const stamp = now().toISOString()
  if (op === 'create_client') return mirrorCreate(db, args, stamp)
  return mirrorBooking(db, args, { read, stamp })
}

async function mirrorBooking(db, args, { read, stamp }) {
  const { op, locationId, contactId, un1tUserId, data, requestedAt } = args
  if (typeof read !== 'function') throw new TypeError('applyUn1tWriteToMirror: read is required for a booking')
  let source = isObj(data) ? data : null
  let ok = true

  if (op === 'cancel') {
    // The cancel answer has no schema: the booking's own read is the truth.
    const id = idText(source?.id)
    try {
      const fresh = id ? await read(`/bookings/${encodeURIComponent(id)}`) : null
      if (isObj(fresh) && sameId(fresh.id, id)) source = fresh
      else {
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
      row = { ...mapBooking(source, { locationId, now: requestedAt || stamp }), crm_written_at: stamp }
      if (typeof source.has_guest === 'boolean') row.has_guest = source.has_guest
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

  const credited = await refreshCredits(db, args, { read, stamp })
  return { ok: ok && credited, row }
}

// One GET /credits/ledgers/{userId}/{studioId} → un1t_clients credit columns.
async function refreshCredits(db, args, { read, stamp }) {
  const { locationId, un1tUserId, studioId } = args
  if (!un1tUserId || !studioId) {
    logError(LOG_MODULE, 'mirror: credits refresh needs the user and the studio', meta(args, 'credits_args_missing'))
    return false
  }
  let ledger
  try {
    ledger = await read(`/credits/ledgers/${encodeURIComponent(un1tUserId)}/${encodeURIComponent(studioId)}`)
  } catch (err) {
    logError(LOG_MODULE, 'mirror: credits read failed', meta(args, err?.code ?? 'credits_read_failed'))
    return false
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
