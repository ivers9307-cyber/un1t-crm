// MIAHATCH.2 — live per-member reads at un1t.online studios (Hatch Street),
// through ONE client that spends from the same per-studio budget as the write
// transport (`un1t-write:<locationId>`, UN1T_WRITE_BUDGET: 30 a minute, the
// write side's share of un1t.online's 60). Mia's read executors (Task 5) sit
// on top of this module; nothing here writes.
//
// - Every HTTP request the client makes (retries included) takes one slot of
//   checkRateLimit first. A spent slot throws Un1tBudgetSpent BEFORE the
//   request, so nothing is sent. checkRateLimit FAILS OPEN when its own RPC
//   errors (it logs and answers allowed), so a limiter outage lets reads
//   through unbudgeted rather than blanking Mia; un1t.online's own 60/min
//   limit still binds, and the client waits that window out.
// - The connection must be an ACTIVE registry row with a token and a studio
//   id. A failed connection read is `read_failed`, never `not_connected`.
// - Logs: module 'mia-un1t', the HTTP status and the location only. Never the
//   token, an email, a phone, a name or a URL (a member id sits in the path).
//   The client's own errors carry no token either (un1t-online.js).
import { createUn1tClient, Un1tAuthError, Un1tApiError } from '@/lib/un1t-online'
import { UN1T_WRITE_BUDGET } from '@/lib/un1t-online-write'
import { readConnection } from '@/lib/connection-registry'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'mia-un1t'
const PLATFORM = 'un1t_online'
/** Pages (100 rows each) one live list read will pull; past it the list is `truncated`. */
export const UN1T_READ_MAX_PAGES = 5

/** The shared budget was spent: nothing was sent, try again after the window. */
export class Un1tBudgetSpent extends Error {
  constructor(message = 'un1t.online read budget spent', { retryAfterSec = null } = {}) {
    super(message)
    this.name = 'Un1tBudgetSpent'
    this.retryAfterSec = retryAfterSec
  }
}

/**
 * Open a budgeted reader for one studio.
 *
 * @param {object} db  service-role Supabase client
 * @param {string} locationId
 * @param {{ clientFactory?: Function, fetchImpl?: Function, sleep?: Function }} [opts]
 * @returns {Promise<{ ok: true, studioId: string, getOne: (path: string) => Promise<any>,
 *   listAll: (path: string) => Promise<{ rows: object[], total: number, truncated: boolean }> }
 *   | { ok: false, reason: 'not_connected' | 'read_failed' }>}
 */
export async function openUn1tMemberReader(db, locationId, { clientFactory = createUn1tClient, fetchImpl, sleep } = {}) {
  let conn = null
  let connError = null
  try {
    ;({ conn, error: connError } = await readConnection(db, locationId, PLATFORM))
  } catch (err) {
    connError = err
  }
  if (connError || !conn) {
    if (connError) {
      logWarn(LOG_MODULE, 'connection read failed', { locationId, errClass: connError?.name, code: connError?.code })
      return { ok: false, reason: 'read_failed' }
    }
    return { ok: false, reason: 'not_connected' }
  }
  if (conn.source !== 'registry' || !conn.isActive || !conn.accessToken || conn.externalAccountId == null) {
    return { ok: false, reason: 'not_connected' }
  }

  const budgetKey = `un1t-write:${locationId}`
  const client = clientFactory({
    token: conn.accessToken,
    maxPages: UN1T_READ_MAX_PAGES,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleep ? { sleep } : {}),
    beforeRequest: async () => {
      const slot = await checkRateLimit(db, budgetKey, UN1T_WRITE_BUDGET)
      if (!slot.allowed) throw new Un1tBudgetSpent(undefined, { retryAfterSec: slot.retryAfterSec })
    },
  })

  return {
    ok: true,
    studioId: String(conn.externalAccountId),
    getOne: (path) => client.getOne(path),
    // Every page is one request, so every page takes one slot.
    listAll: (path) => client.listAll(path, { requireList: true }),
  }
}

/** Log one failed read: the status and the location, never the path or the message. */
function logReadFailure(locationId, op, err) {
  const status = err instanceof Un1tApiError || err instanceof Un1tAuthError ? err.status ?? null : null
  const meta = { locationId, op, status, errClass: err?.name }
  logWarn(LOG_MODULE, err instanceof Un1tAuthError ? 'un1t.online refused the token' : 'un1t.online read failed', meta)
}

/**
 * Live GET /users/{id}/bookings for one member, every page up to
 * UN1T_READ_MAX_PAGES (a member's future bookings may sit past page 1). A list
 * the cap cut comes back `truncated: true`: it may be incomplete, so a caller
 * must not read "not in the list" as "no such booking".
 *
 * @param {object} db
 * @param {{ locationId: string, un1tUserId: string }} args
 * @param {{ clientFactory?: Function, fetchImpl?: Function, sleep?: Function }} [deps]
 * @returns {Promise<{ ok: true, rows: object[], truncated?: true } | { ok: false, reason: 'not_connected' | 'read_failed' | 'budget_spent' }>}
 */
export async function fetchLiveUn1tBookings(db, { locationId, un1tUserId } = {}, deps = {}) {
  if (!locationId || !un1tUserId) return { ok: false, reason: 'read_failed' }
  const reader = await openUn1tMemberReader(db, locationId, deps)
  if (!reader.ok) return { ok: false, reason: reader.reason }
  try {
    const { rows, total, truncated } = await reader.listAll(`/users/${encodeURIComponent(String(un1tUserId))}/bookings`)
    // Belt and braces behind requireList: a row that is not an object is not a booking.
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      logWarn(LOG_MODULE, 'un1t.online sent bookings that are not a list of objects', { locationId, op: 'bookings', status: null })
      return { ok: false, reason: 'read_failed' }
    }
    if (truncated) {
      logWarn(LOG_MODULE, 'live bookings read hit the page cap', { locationId, op: 'bookings', maxPages: UN1T_READ_MAX_PAGES, read: rows.length, total })
      return { ok: true, rows, truncated: true }
    }
    return { ok: true, rows }
  } catch (err) {
    if (err instanceof Un1tBudgetSpent) {
      logWarn(LOG_MODULE, 'read budget spent', { locationId, op: 'bookings', status: null, retryAfterSec: err.retryAfterSec })
      return { ok: false, reason: 'budget_spent' }
    }
    logReadFailure(locationId, 'bookings', err)
    return { ok: false, reason: 'read_failed' }
  }
}
