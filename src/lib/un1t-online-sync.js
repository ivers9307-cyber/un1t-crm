// UN1TSYNC.6 — the un1t.online → CRM sync engine for one studio.
//
// One run pulls every list (the API ignores `updated_since`), in this order.
// UN1TINCR.1: bookings and transactions, the two lists that grow without
// bound and that no reader judges by freshness, are read as a head (every
// row created in the last UN1T_WINDOW_DAYS, newest first) plus a slice of
// UN1T_SWEEP_PAGES pages of the whole history, oldest first, from a cursor
// kept in the last ok run's counts.sweep, so old rows are still re-read on a
// rolling cycle. While a list is shorter than the window the head reads it
// all and nothing changes. Every other list stays a full read, because the
// freshness rule (un1t-online-freshness.js) and the membership endings read
// a row missing from the latest pull as gone upstream.
//
//   1. Open a un1t_sync_runs row (status 'running'). At most ONE runs per
//      studio (UN1THARD.1, mig 735's partial unique index): a second run's
//      insert fails 23505 and that run returns reason 'in_progress' having
//      read and written nothing. Rows left 'running' longer than
//      STALE_RUN_MS (a killed process) are closed as abandoned first, so a
//      dead run never blocks the studio for good.
//   2. Read the studio's connection from the registry. No active row or no
//      token → not_connected; the connection row is left alone. A registry
//      read that FAILED is 'db', never "not connected" (REGISTRYREAD.1).
//   3. GET /api-token. Its studio must be the stored external_account_id,
//      else studio_mismatch. The token's expiry is recorded on the connection.
//   4. Pull EVERY list before ANY table write: a list that fails, a list cut
//      off by the page cap, or a row from another studio refuses the whole
//      run with nothing written (the mirror is never half one pull and half
//      the last).
//   5. Resolve un1t.online clients to org-scoped contacts (Task 4).
//   6. Upsert the seven un1t_* tables in chunks of 200. The first failed
//      upsert stops the run ('db'); later tables wait for the next run.
//      The events are then projected into class_occurrences (UN1TCLASS.2;
//      a future un1t occurrence this pull did not return is stamped
//      cancelled_at, UN1TBOOK.20, so a class deleted upstream leaves the TVs),
//      and the bookings into class_bookings (UN1TBOOK.3, source_platform
//      'un1t_online', which the CRM never reminds or credits), both only
//      where the studio's membership_source is 'un1t_online': a projection
//      failure is recorded in counts and never fails the run.
//   6c. Measure the history window (UN1THARD.2): per dated table, how many
//      rows the mirror holds that this pull did not return (every pulled row
//      was just upserted with synced_at = this run's start, so an older
//      synced_at means "not in this pull"), and the oldest row pulled. A
//      non-zero `absent_from_pull` on bookings or events means un1t.online's
//      list is a rolling window (or deleted rows): the mirror is then the only
//      full history, which is why it never prunes. Informational only.
//   7. Decide the memberships (ORGCONTACTS.7: the facts live on contact_studios; this
//      location only; the operator export's rows are never touched): a
//      contact with an active subscription is upserted active; an active row
//      whose contact no longer has one is ENDED, never deleted.
//   7a. Write the relationship rows (contact_studios, mig 764): member, client.
//   7b. Write the membership facts onto those rows (mig 770; the sync is the
//      one writer of membership_plan / _status / _since / _ended_at).
//   7c. Start this studio's contact_created sequences for new signups.
//   8. Record the outcome on the connection; 9. close the run row.
//
// NEVER DELETES. Nothing in a run issues a delete: a row absent from a pull
// stays, and a membership absent from a pull is ended.
//
// Two guards on step 7, because an ended membership is customer-facing (event
// member pricing reads the active member rows on contact_studios) and a wrongly ended one charges a
// member the non-member fee:
//   - A client that FAILED to resolve (a contacts read or write error) has a
//     subscription that cannot be attributed, so "its contact has no
//     subscription" is unknown, not false. Only THAT contact's active row is
//     spared (matched through contacts.un1t_user_id); every other cancellation
//     at the studio still ends. A persistent one-client failure therefore
//     never freezes the studio's endings. Counted in end_skipped_unresolved.
//     If the contacts read that makes this match fails, the whole end step
//     waits for the next run (end_skipped 'contacts_unreadable').
//   - If the pull carried no subscriptions at all, the end step is skipped:
//     an empty list ending every member is far likelier an upstream fault
//     than every member cancelling at once (end_skipped
//     'no_subscriptions_pulled').
//
// Bookkeeping writes (the connection's status, the run row's close) are
// logged when they fail and never change the run's result: the data written
// is still written.

import { createUn1tClient, Un1tAuthError } from './un1t-online.js'
import {
  mapClient,
  mapProduct,
  mapSubscription,
  mapTransaction,
  mapInvoice,
  mapEvent,
  mapBooking,
  rowStudioId,
  MEMBERSHIP_ACTIVE_STATUSES,
} from './un1t-online-map.js'
import { projectUn1tOccurrences } from './un1t-online-occurrences.js'
import { projectUn1tBookings } from './un1t-online-bookings.js'
import { resolveUn1tContacts } from './un1t-online-contacts.js'
import { ensureStudioPreferences } from './un1t-online-studio-preferences.js'
import { upsertContactStudio, setMembershipFacts } from './contact-studios.js'
import { tokenFingerprint } from './un1t-online-token.js'
import { readConnection } from './connection-registry.js'
import { logError, logWarn, logInfo } from './log'

export const UN1T_LISTS = Object.freeze([
  '/products',
  '/events',
  '/users/clients',
  '/subscriptions',
  '/transactions',
  '/invoices',
  '/bookings',
])

// UN1TINCR.1 — the incremental lists (see the header). A booking is made at
// most ~30 days before its class (un1t.online generates series a month
// ahead) and settles at the class, so 60 days covers every row that still
// changes; the sweep catches a late edit to anything older.
export const UN1T_WINDOWED_LISTS = Object.freeze(['/transactions', '/bookings'])
export const UN1T_WINDOW_DAYS = 60
export const UN1T_SWEEP_PAGES = 2
// The page cap for a full list (100 rows a page). At 60 requests a minute a
// 150-page list is about 2.5 minutes of a run, inside the cron's 300 s.
export const UN1T_FULL_LIST_MAX_PAGES = 150
// A full list past this many rows (60% of the cap) puts a warning on the
// connection, months before the cap would refuse a run.
export const UN1T_HEADROOM_ROWS = Math.floor(UN1T_FULL_LIST_MAX_PAGES * 100 * 0.6)

const PLATFORM = 'un1t_online'
const CHUNK = 200
const PAGE = 1000
const MAX_ERROR_LEN = 500
// A run row still 'running' after this long belongs to a process that died
// (the cron's maxDuration is 300 s, the Sync now route's 120 s).
export const STALE_RUN_MS = 15 * 60 * 1000
const ABANDONED = 'abandoned: the run never finished (the process stopped before closing it)'

// Dated tables whose history window is measured each run (step 6c), and the
// column that dates a row.
const HISTORY_TABLES = Object.freeze({ un1t_bookings: 'remote_created_at', un1t_events: 'starts_at' })

const AUTH_ERROR =
  'un1t.online token rejected (revoked or expired). Paste a new token in Settings → Integrations → un1t.online.'

// API path → { kind for rowStudioId, short name in counts }.
const LIST_META = Object.freeze({
  '/products': { kind: 'product', name: 'products' },
  '/events': { kind: 'event', name: 'events' },
  '/users/clients': { kind: 'client', name: 'clients' },
  '/subscriptions': { kind: 'subscription', name: 'subscriptions' },
  '/transactions': { kind: 'transaction', name: 'transactions' },
  '/invoices': { kind: 'invoice', name: 'invoices' },
  '/bookings': { kind: 'booking', name: 'bookings' },
})

// Upsert order (step 6). `contact` = the row carries un1t_user_id → contact_id.
const TABLES = Object.freeze([
  { table: 'un1t_products', list: '/products', map: mapProduct, key: 'un1t_id', contact: false },
  { table: 'un1t_events', list: '/events', map: mapEvent, key: 'un1t_id', contact: false },
  { table: 'un1t_clients', list: '/users/clients', map: mapClient, key: 'un1t_user_id', contact: true },
  { table: 'un1t_subscriptions', list: '/subscriptions', map: mapSubscription, key: 'un1t_id', contact: true },
  { table: 'un1t_transactions', list: '/transactions', map: mapTransaction, key: 'un1t_id', contact: true },
  { table: 'un1t_invoices', list: '/invoices', map: mapInvoice, key: 'un1t_id', contact: true },
  { table: 'un1t_bookings', list: '/bookings', map: mapBooking, key: 'un1t_id', contact: true },
])

function messageOf(err) {
  const raw = err?.message || err?.code || (typeof err === 'string' ? err : '') || 'unknown error'
  const s = String(raw)
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s
}

/**
 * What may be logged of a PostgREST / thrown error: its code and message,
 * never `details` or `hint`. A constraint violation's details is
 * "Failing row contains (…)", which on channel_connections includes the
 * access token.
 */
function safeErr(err) {
  if (err == null) return null
  if (typeof err === 'string') return { code: null, message: err }
  return { code: err.code ?? null, message: messageOf(err) }
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Last row wins per conflict key, so one upsert never touches a row twice. */
function dedupeBy(rows, key) {
  const byKey = new Map()
  for (const r of rows) byKey.set(r[key], r)
  return [...byKey.values()]
}

// Highest-priority active status first, then the latest period end.
function preferSubscription(a, b) {
  const ra = MEMBERSHIP_ACTIVE_STATUSES.indexOf(a.status)
  const rb = MEMBERSHIP_ACTIVE_STATUSES.indexOf(b.status)
  if (ra !== rb) return ra < rb ? a : b
  return String(b.current_period_end || '') > String(a.current_period_end || '') ? b : a
}

/**
 * Run one full un1t.online sync for a location.
 *
 * @param {object} db           supabase service-role client
 * @param {string} locationId
 * @param {object} [opts]
 * @param {Function} [opts.clientFactory]  createUn1tClient-compatible factory
 * @param {Function} [opts.now]            () => Date
 * @returns {Promise<{ ok: boolean, reason?: 'in_progress'|'not_connected'|'auth'|'studio_mismatch'|'api'|'truncated'|'db', counts: object, runId: string|null }>}
 */
export async function runUn1tSync(db, locationId, { clientFactory = createUn1tClient, now = () => new Date() } = {}) {
  const startedAt = now()
  const nowIso = startedAt.toISOString()
  const counts = { pulled: {}, tables: {}, contacts: null, contact_errors: [], memberships: null, api: null }

  // 1. The run row. First close this studio's abandoned runs (a killed
  // process never closes its row, and mig 735 allows one 'running' row per
  // location). Best-effort: a failure here only means a dead row may refuse
  // this run as in_progress until the next tick retries.
  {
    const staleBefore = new Date(startedAt.getTime() - STALE_RUN_MS).toISOString()
    const { data: closed, error: closeError } = await db
      .from('un1t_sync_runs')
      .update({ status: 'error', finished_at: nowIso, first_error: ABANDONED })
      .eq('location_id', locationId)
      .eq('status', 'running')
      .lt('started_at', staleBefore)
      .select('id')
    if (closeError) {
      logWarn('un1t-online-sync', 'could not close abandoned sync runs', { locationId, err: safeErr(closeError) })
    } else if (Array.isArray(closed) && closed.length > 0) {
      logWarn('un1t-online-sync', 'closed abandoned sync runs', { locationId, count: closed.length })
    }
  }
  let runId = null
  {
    const { data, error } = await db
      .from('un1t_sync_runs')
      .insert({ location_id: locationId, status: 'running', started_at: nowIso })
      .select('id')
    const row = Array.isArray(data) ? data[0] : null
    if (error?.code === '23505') {
      // Another run for this studio is in flight (the cron and Sync now, or
      // two clicks). Not a fault: nothing was read or written, and the run in
      // flight brings the mirror up to date.
      logInfo('un1t-online-sync', 'a sync is already running for this location; not starting another', { locationId })
      return { ok: false, reason: 'in_progress', counts, runId: null }
    }
    if (error || !row?.id) {
      // Nothing has been read or written yet, and the next tick retries.
      logError('un1t-online-sync', 'could not open a sync run row', { locationId, err: safeErr(error || 'no row returned') })
      return { ok: false, reason: 'db', counts, runId: null }
    }
    runId = row.id
  }

  let client = null
  // The token this run read. Every connection write is guarded on it, so a
  // run still in flight when the connect route replaces the token in place
  // cannot stamp the NEW token's row with the old token's outcome.
  let connIdentity = null
  // `connectionPatch` is the connection write for this outcome; null leaves
  // the connection untouched (not_connected, or no connection to identify).
  const finish = async ({ ok, reason, firstError, connectionPatch }) => {
    if (client) {
      try {
        counts.api = client.stats()
      } catch {
        counts.api = null
      }
    }
    if (connectionPatch) {
      const res = await updateConnection(db, locationId, connectionPatch, connIdentity)
      if (res.superseded) counts.connection_update_skipped = 'superseded'
      else if (res.error) counts.connection_update_error = res.error
    }
    const finishedAt = now()
    const { error } = await db
      .from('un1t_sync_runs')
      .update({
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        status: ok ? 'ok' : 'error',
        counts,
        first_error: firstError ?? null,
      })
      .eq('id', runId)
      .select('id')
    if (error) logError('un1t-online-sync', 'could not close the sync run row', { locationId, runId, err: safeErr(error) })
    const result = { ok, counts, runId }
    if (!ok) result.reason = reason
    return result
  }

  const failure = (reason, firstError, connectionPatch) => {
    if (reason !== 'auth' && reason !== 'not_connected') {
      logWarn('un1t-online-sync', 'sync run failed', { locationId, runId, reason, firstError })
    }
    return finish({ ok: false, reason, firstError, connectionPatch })
  }
  const errorPatch = (lastError, extra = {}) => ({ status: 'error', last_error: lastError, ...extra })

  // 2. The connection.
  const { conn, error: connError } = await readConnection(db, locationId, PLATFORM)
  if (connError || !conn) {
    return failure('db', `connection read failed: ${messageOf(connError)}`, null)
  }
  if (conn.source !== 'registry' || !conn.isActive || !conn.accessToken) {
    return failure('not_connected', 'un1t.online is not connected for this location', null)
  }
  // The fingerprint is stored by the connect route; a row from before it has
  // none and falls back to comparing the token in memory.
  connIdentity = {
    token: conn.accessToken,
    fingerprint: conn.config?.token_fingerprint ? tokenFingerprint(conn.accessToken) : null,
  }
  const storedStudio = conn.externalAccountId == null ? null : String(conn.externalAccountId)

  // 3. Who the token is.
  let self
  try {
    client = clientFactory({ token: conn.accessToken, maxPages: UN1T_FULL_LIST_MAX_PAGES })
    self = await client.getSelf()
  } catch (err) {
    if (err instanceof Un1tAuthError) {
      return failure('auth', `GET /api-token: ${messageOf(err)}`, { status: 'action_needed', last_error: AUTH_ERROR })
    }
    const msg = `un1t.online sync failed at /api-token: ${messageOf(err)}`
    return failure('api', msg, errorPatch(msg))
  }
  const tokenStudio = self?.studio?.id == null ? null : String(self.studio.id)
  if (!tokenStudio) {
    const msg = 'un1t.online sync failed at /api-token: the answer named no studio'
    return failure('api', msg, errorPatch(msg))
  }
  if (tokenStudio !== storedStudio) {
    const msg = `un1t.online token is for studio ${tokenStudio}, but this location is connected to studio ${storedStudio ?? '(none)'}. Nothing was synced.`
    return failure('studio_mismatch', msg, errorPatch(msg))
  }
  // From here on every connection write also records the token's expiry.
  const tokenFields = { token_expires_at: self.expires_at ?? null }

  // 4. Pull every list before any write.
  const pulled = {}
  const since = new Date(startedAt.getTime() - UN1T_WINDOW_DAYS * 86_400_000).toISOString()
  const cursors = await readSweepCursors(db, locationId)
  counts.window = { since }
  counts.sweep = {}
  counts.headroom = {}
  for (const path of UN1T_LISTS) {
    const meta = LIST_META[path]
    let res
    try {
      if (UN1T_WINDOWED_LISTS.includes(path)) {
        res = await pullWindowed(client, path, { since, fromPage: cursors[meta.name] ?? 1 })
        counts.window[meta.name] = res.window
        if (res.sweep) counts.sweep[meta.name] = res.sweep
      } else {
        res = await client.listAll(path)
        if (Number(res?.total) > UN1T_HEADROOM_ROWS) counts.headroom[meta.name] = Number(res.total)
      }
    } catch (err) {
      if (err instanceof Un1tAuthError) {
        return failure('auth', `GET ${path}: ${messageOf(err)}`, { status: 'action_needed', last_error: AUTH_ERROR, ...tokenFields })
      }
      const msg = `un1t.online sync failed at list ${path}: ${messageOf(err)}. Nothing was written.`
      return failure('api', msg, errorPatch(msg, tokenFields))
    }
    const rows = Array.isArray(res?.rows) ? res.rows : []
    counts.pulled[meta.name] = rows.length

    const foreign = rows.find((row) => {
      const sid = rowStudioId(meta.kind, row)
      return sid != null && sid !== tokenStudio
    })
    if (foreign) {
      const msg = `un1t.online list ${path} returned a row from studio ${rowStudioId(meta.kind, foreign)}, but this location is connected to studio ${tokenStudio}. Nothing was synced.`
      return failure('studio_mismatch', msg, errorPatch(msg, tokenFields))
    }
    if (res?.truncated) {
      const msg = `un1t.online sync refused: list ${path} exceeded the page cap (${rows.length} of ${res.total ?? '?'} rows read). Nothing was written.`
      return failure('truncated', msg, errorPatch(msg, tokenFields))
    }
    pulled[path] = rows
  }

  // 5–7. Every database step. A thrown exception here (a builder never
  // throws; a bug might) is reported as 'db' rather than escaping the run.
  try {
    // 5. Organisation + contacts.
    const { data: loc, error: locError } = await db
      .from('locations')
      .select('id, organization_id, membership_source')
      .eq('id', locationId)
      .maybeSingle()
    if (locError || !loc?.organization_id) {
      const msg = `un1t.online sync failed reading the location's organisation: ${locError ? messageOf(locError) : 'no organisation'}`
      return failure('db', msg, errorPatch(msg, tokenFields))
    }
    const organizationId = loc.organization_id

    const resolved = await resolveUn1tContacts(db, {
      locationId,
      organizationId,
      clients: pulled['/users/clients'],
      now: nowIso,
    })
    counts.contacts = resolved.counts
    // un1t user ids and reasons only: no names or emails in the run row.
    counts.contact_errors = (resolved.errors || []).slice(0, 20)
    const contactIdOf = (userId) => (userId == null ? null : resolved.contactIdByUserId.get(String(userId)) ?? null)

    // 5b. A client linked to ANOTHER studio's contact has no marketing-
    // preferences row here, and a missing row means no send (UN1TDUAL.3).
    // Insert-if-missing only; informational like 6b: a failure is recorded in
    // counts and never changes the run's status or the connection's.
    const linkedElsewhere = []
    for (const [userId, contactId] of resolved.contactIdByUserId) {
      const home = resolved.contactLocationByUserId?.get(userId)
      if (home && home !== locationId) linkedElsewhere.push(contactId)
    }
    const studioPrefs = await ensureStudioPreferences(db, { locationId, contactIds: linkedElsewhere, nowIso })
    counts.studio_preferences = studioPrefs
    if (studioPrefs.error) {
      // created > 0 means rows exist whose consent_log opt_in may be missing
      // (a later run skips them, so nothing retries): structured and loud.
      logError('un1t-online-sync', 'could not create marketing-preference rows for linked contacts', {
        locationId, runId, count: studioPrefs.created, code: studioPrefs.error.code, message: studioPrefs.error.message,
      })
    }

    // 6. The mirror tables.
    const mapped = {}
    for (const spec of TABLES) {
      const rows = []
      for (const apiRow of pulled[spec.list]) {
        const row = spec.map(apiRow, { locationId, now: nowIso })
        if (!row) continue
        if (spec.contact) row.contact_id = contactIdOf(row.un1t_user_id)
        rows.push(row)
      }
      const unique = dedupeBy(rows, spec.key)
      mapped[spec.table] = unique
      const onConflict = `location_id,${spec.key}`
      for (const chunk of chunks(unique, CHUNK)) {
        const { error } = await db.from(spec.table).upsert(chunk, { onConflict })
        if (error) {
          const msg = `un1t.online sync failed writing ${spec.table}: ${messageOf(error)}`
          return failure('db', msg, errorPatch(msg, tokenFields))
        }
      }
      counts.tables[spec.table] = unique.length

      // 6b. Project the events just written into class_occurrences (UN1TCLASS.2),
      // so the studio's timetable reaches the TVs and dashboards. Informational
      // only: it never changes the run's status or the connection's, because
      // the membership and contact data are this run's primary payload.
      // Only where this studio's timetable IS un1t.online: a Glofox studio that
      // also holds a un1t.online connection must not get un1t classes beside
      // its Glofox ones (TVs, climate, bridge linking all read the table).
      if (spec.table === 'un1t_events' && loc.membership_source !== 'un1t_online') {
        counts.class_occurrences = { skipped: 'membership_source' }
      } else if (spec.table === 'un1t_events') {
        const projected = await projectUn1tOccurrences(db, { locationId, events: unique, nowIso })
        counts.class_occurrences = projected
        if (projected.error) {
          logWarn('un1t-online-sync', 'could not project events into class_occurrences', { locationId, runId, err: projected.error })
        }
      }

      // 6b (bookings). Project the bookings just written into class_bookings
      // (UN1TBOOK.3), so the scorecard, the /live roster and campaign outcomes
      // see this studio's visits. Same gate and same informational status as 6b; the
      // rows carry source_platform 'un1t_online', which the reminder and
      // crediting crons never read (un1t.online reminds and credits itself).
      if (spec.table === 'un1t_bookings' && loc.membership_source !== 'un1t_online') {
        counts.class_bookings = { skipped: 'membership_source' }
      } else if (spec.table === 'un1t_bookings') {
        const projected = await projectUn1tBookings(db, {
          locationId,
          bookings: unique,
          events: mapped.un1t_events,
          nowIso,
        })
        counts.class_bookings = projected
        if (projected.error) {
          logWarn('un1t-online-sync', 'could not project bookings into class_bookings', { locationId, runId, err: projected.error })
        }
      }
    }

    // 6c. The history window (UN1THARD.2). Informational: a failed count is
    // recorded and never changes the run's status or the connection's.
    // A windowed bookings pull only vouches for the rows created in its window.
    const windowSince = counts.window.bookings && !counts.window.bookings.full ? since : null
    counts.history = await measureHistory(db, { locationId, mapped, nowIso, windowSince })
    if (Object.values(counts.history).some((h) => h.absent_from_pull > 0)) {
      logInfo('un1t-online-sync', 'the mirror holds rows this pull did not return (rolling window or upstream delete)', {
        locationId, runId, history: counts.history,
      })
    }

    // 7. Memberships.
    const membership = await reconcileMemberships(db, {
      locationId,
      subscriptions: mapped.un1t_subscriptions,
      contactIdOf,
      resolverErrors: resolved.errors || [],
    })
    counts.memberships = membership.counts
    if (membership.error) {
      const msg = `un1t.online sync failed reading membership facts: ${membership.error}`
      return failure('db', msg, errorPatch(msg, tokenFields))
    }

    // 7a. ORGCONTACTS.1 — the relationship table (mig 764): a member row for
    // every live subscriber, a client row for every other client linked to a
    // contact, and a client row (never an ended one: a lapsed client keeps a
    // relationship) for a membership this run ended. A failed write here is
    // counted and logged, never the run's status.
    counts.contact_studios = await writeContactStudios(db, {
      locationId,
      clients: mapped.un1t_clients || [],
      contactIdOf,
      memberContactIds: membership.memberContactIds || [],
      endedContactIds: membership.endedContactIds || [],
      nowIso,
    })

    // 7b. ORGCONTACTS.7 (mig 770) — the membership facts (plan, active or
    // ended, since, ended_at) onto the rows 7a just wrote: activations, then
    // endings. The sync is the ONLY writer of those columns. A row 7a could not
    // write is counted (rows_missing) and logged; a failed facts write too;
    // neither is the run's failure (the next run repairs).
    counts.memberships = {
      ...counts.memberships,
      ...(await writeMembershipFacts(db, {
        locationId,
        memberContactIds: membership.memberContactIds || [],
        plan: membership.plan || new Map(),
        activePlanByContact: membership.activePlanByContact || new Map(),
        endedContactIds: membership.endedContactIds || [],
        nowIso,
      })),
    }

    // 7c. New signups start this studio's contact_created sequences
    // (SHAREDCONTACT.1). Last, so the bookings this run projected are already
    // there for a "booked a class here?" branch. Informational: a failure is
    // logged by the trigger and never changes the run's status.
    counts.signups = await fireSignupTriggers({
      locationId,
      membershipSource: loc.membership_source,
      newlyLinked: resolved.newlyLinked || [],
      nowIso,
    })
  } catch (err) {
    const msg = `un1t.online sync failed: ${messageOf(err)}`
    logError('un1t-online-sync', 'unexpected exception in a sync run', { locationId, runId, err: safeErr(err) })
    return failure('db', msg, errorPatch(msg, tokenFields))
  }

  // 8–9. Success. A run that synced but could not match some members to
  // contacts stays 'connected' (the data is fresh) and says so in last_error,
  // which the health row grades as a warning. Counts only: no names or emails.
  const cc = counts.contacts || {}
  const failedN = cc.failed || 0
  const conflictN = cc.conflict || 0
  const ambiguousN = cc.ambiguous_email || 0
  const unmatched = failedN + conflictN + ambiguousN
  const warnings = []
  if (unmatched > 0) {
    warnings.push(`Synced, but ${unmatched} un1t.online member${unmatched === 1 ? '' : 's'} could not be matched to contacts (${failedN} failed, ${conflictN} conflicts, ${ambiguousN} ambiguous emails).`)
  }
  for (const [name, total] of Object.entries(counts.headroom)) {
    warnings.push(`The un1t.online ${name} list has ${total} rows; a sync stops at ${UN1T_FULL_LIST_MAX_PAGES * 100}. Ask un1t.online for an updated_since filter on it.`)
  }
  const warning = warnings.length > 0 ? warnings.join(' ') : null
  return finish({
    ok: true,
    firstError: null,
    connectionPatch: { status: 'connected', last_ok_at: nowIso, last_error: warning, ...tokenFields },
  })
}

/**
 * Step 6c. Per dated table: rows held at this location that this pull did not
 * return (synced_at older than this run's start), and the oldest row pulled.
 * `windowSince` (UN1TINCR.1): a windowed bookings pull vouches only for the
 * rows created since it, so only those are counted (and it is recorded).
 * @returns {Promise<Record<string, { absent_from_pull: number|null, oldest_pulled: string|null, window_since?: string, error?: string }>>}
 */
async function measureHistory(db, { locationId, mapped, nowIso, windowSince = null }) {
  const out = {}
  for (const [table, dateCol] of Object.entries(HISTORY_TABLES)) {
    const rows = Array.isArray(mapped[table]) ? mapped[table] : []
    let oldest = null
    for (const r of rows) {
      const v = r[dateCol]
      if (typeof v === 'string' && v !== '' && (oldest === null || v < oldest)) oldest = v
    }
    const windowed = table === 'un1t_bookings' && windowSince
    let query = db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .lt('synced_at', nowIso)
    if (windowed) query = query.gte('remote_created_at', windowSince)
    const { count, error } = await query
    const base = windowed ? { window_since: windowSince } : {}
    out[table] = error
      ? { absent_from_pull: null, oldest_pulled: oldest, ...base, error: messageOf(error) }
      : { absent_from_pull: Number.isFinite(count) ? count : null, oldest_pulled: oldest, ...base }
  }
  return out
}

/**
 * UN1TINCR.1 — one windowed list: the head (every row created since `since`,
 * newest first), then, when the head stopped short of the end, a sweep slice
 * of UN1T_SWEEP_PAGES pages oldest first from `fromPage`. Rows are merged by
 * id (the head's copy kept). A head that reached the end read everything, so
 * no sweep runs and the cursor stays. Throws what listAll throws.
 */
async function pullWindowed(client, path, { since, fromPage }) {
  const head = await client.listAll(path, { newerThan: since })
  const headRows = Array.isArray(head?.rows) ? head.rows : []
  if (head?.truncated || !head?.stoppedEarly) {
    return {
      rows: headRows,
      total: head?.total,
      truncated: Boolean(head?.truncated),
      window: { head: headRows.length, sweep: 0, full: !head?.truncated },
      sweep: { from_page: fromPage, next_page: fromPage, pages: Number(head?.pages) || 1 },
    }
  }
  const slice = await client.listAll(path, { ascending: true, startPage: fromPage, pageLimit: UN1T_SWEEP_PAGES })
  const sliceRows = Array.isArray(slice?.rows) ? slice.rows : []
  const pages = Number(slice?.pages) || Number(head.pages) || 1
  const next = fromPage + UN1T_SWEEP_PAGES > pages ? 1 : fromPage + UN1T_SWEEP_PAGES
  const ids = new Set(headRows.map((r) => r?.id).filter((id) => id != null))
  const rows = [...headRows, ...sliceRows.filter((r) => r?.id == null || !ids.has(r.id))]
  return {
    rows,
    total: head.total,
    truncated: false,
    window: { head: headRows.length, sweep: sliceRows.length, full: false },
    sweep: { from_page: fromPage, next_page: next, pages },
  }
}

/**
 * UN1TINCR.1 — where each windowed list's sweep starts: the next_page the
 * last ok run recorded. Never fails the run: an unreadable or missing cursor
 * starts at page 1 (the sweep is a refresh, so starting over costs nothing).
 * @returns {Promise<Record<string, number>>}
 */
async function readSweepCursors(db, locationId) {
  const { data, error } = await db
    .from('un1t_sync_runs')
    .select('counts')
    .eq('location_id', locationId)
    .eq('status', 'ok')
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) {
    logWarn('un1t-online-sync', 'could not read the last sweep position; sweeping from page 1', { locationId, err: safeErr(error) })
    return {}
  }
  const sweep = Array.isArray(data) && data[0]?.counts?.sweep
  const out = {}
  if (sweep && typeof sweep === 'object') {
    for (const [name, s] of Object.entries(sweep)) {
      const n = Number(s?.next_page)
      if (Number.isInteger(n) && n > 0) out[name] = n
    }
  }
  return out
}

/**
 * Step 7. Decides who is a member here and whose membership ends; it writes
 * nothing (7a writes the relationship rows, 7b the membership facts). Returns
 * { counts, error, memberContactIds, endedContactIds, plan, activePlanByContact },
 * error a message or null.
 */
async function reconcileMemberships(db, { locationId, subscriptions, contactIdOf, resolverErrors }) {
  const counts = { active: 0, ended: 0, skipped_no_contact: 0 }
  // ORGCONTACTS.1 — who this run holds as a member here, and whose
  // membership it ended (contact ids), for the contact_studios dual-write.
  const endedContactIds = []
  const plan = new Map()

  // One plan per contact: the best active subscription.
  const best = new Map()
  // An active subscription whose user did not resolve to a contact this run
  // (not in the client pull, or null user id) has an unknown owner: its
  // contact's existing row must not end on the strength of its absence.
  const skippedUserIds = new Set()
  let skippedWithoutUser = false
  for (const sub of subscriptions) {
    if (!MEMBERSHIP_ACTIVE_STATUSES.includes(sub.status)) continue
    const contactId = contactIdOf(sub.un1t_user_id)
    if (!contactId) {
      counts.skipped_no_contact += 1
      if (sub.un1t_user_id == null) skippedWithoutUser = true
      else skippedUserIds.add(String(sub.un1t_user_id))
      continue
    }
    const prev = best.get(contactId)
    best.set(contactId, prev ? preferSubscription(prev, sub) : sub)
  }

  // ORGCONTACTS.7 (mig 770): the facts are written onto the relationship row
  // by writeMembershipFacts, AFTER writeContactStudios has made the row. Here
  // only the plan per member is decided.
  for (const [contactId, sub] of best.entries()) plan.set(contactId, (sub.product_title && sub.product_title.trim()) || 'Membership')
  counts.active = best.size
  const memberContactIds = [...best.keys()]

  // The relationship rows carrying an ACTIVE membership here, read in full
  // (1,000-row pages). Filtered on THIS studio: another studio's membership is
  // never read as ours nor ended by us.
  const activeRows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contact_studios')
      .select('contact_id, membership_plan')
      .eq('location_id', locationId)
      .eq('membership_status', 'active')
      .order('contact_id')
      .range(from, from + PAGE - 1)
    if (error) return { counts, error: `reading membership facts: ${messageOf(error)}` }
    const rows = Array.isArray(data) ? data : []
    activeRows.push(...rows)
    if (rows.length < PAGE) break
  }

  // what each live member's row already says, so an unchanged member gets no write (7b)
  const activePlanByContact = new Map(activeRows.map((r) => [r.contact_id, r.membership_plan ?? null]))
  let toEnd = activeRows.filter((r) => !best.has(r.contact_id))
  if (toEnd.length === 0) return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }

  if (subscriptions.length === 0) {
    counts.end_skipped = 'no_subscriptions_pulled'
    counts.would_end = toEnd.length
    logWarn('un1t-online-sync', 'not ending memberships: the pull carried no subscriptions', { locationId, wouldEnd: toEnd.length })
    return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }
  }

  // Every client the resolver could not attribute has an unknown
  // subscription this run, so its contact's row must not end.
  //   - An error with no un1t_user_id cannot be attributed to anyone: end
  //     NOTHING this run (fail closed).
  //   - Otherwise spare (a) every contact the resolver named on an error
  //     (contact_id / contact_ids: a failed attach or null-fill, a conflict,
  //     an ambiguous email), even one whose un1t_user_id is not set, and
  //     (b) every contact whose un1t_user_id is a failed client's, read by id
  //     in chunks (under the 1,000-row cap). Every other row ends, so one
  //     client failing on every run never freezes the studio's endings.
  if (resolverErrors.length > 0 || skippedUserIds.size > 0 || skippedWithoutUser) {
    if (skippedWithoutUser || resolverErrors.some((e) => e?.un1t_user_id == null)) {
      counts.end_skipped = 'contacts_unresolved'
      counts.would_end = toEnd.length
      logWarn('un1t-online-sync', 'not ending memberships: a client or subscription could not be attributed to a user id', { locationId, wouldEnd: toEnd.length })
      return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }
    }
    const spared = new Set()
    for (const e of resolverErrors) {
      if (e.contact_id != null) spared.add(String(e.contact_id))
      for (const id of Array.isArray(e.contact_ids) ? e.contact_ids : []) spared.add(String(id))
    }
    const unresolvedUserIds = new Set([...resolverErrors.map((e) => String(e.un1t_user_id)), ...skippedUserIds])
    const contactIds = [...new Set(toEnd.map((r) => r.contact_id))].filter((id) => !spared.has(String(id)))
    for (const ids of chunks(contactIds, CHUNK)) {
      const { data, error } = await db
        .from('contacts')
        .select('id, un1t_user_id')
        .in('id', ids)
      if (error) {
        // Which rows to spare is unknown: end nothing this run, rather than
        // risk ending a member whose client merely failed to resolve.
        counts.end_skipped = 'contacts_unreadable'
        counts.would_end = toEnd.length
        logWarn('un1t-online-sync', 'not ending memberships: could not read contacts to spare unresolved clients', { locationId, wouldEnd: toEnd.length, err: safeErr(error) })
        return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }
      }
      for (const c of data || []) {
        if (c.un1t_user_id != null && unresolvedUserIds.has(String(c.un1t_user_id))) spared.add(String(c.id))
      }
    }
    const before = toEnd.length
    toEnd = toEnd.filter((r) => !spared.has(String(r.contact_id)))
    counts.end_skipped_unresolved = before - toEnd.length
    if (counts.end_skipped_unresolved > 0) {
      logWarn('un1t-online-sync', 'not ending memberships of clients that failed to resolve', { locationId, spared: counts.end_skipped_unresolved })
    }
    if (toEnd.length === 0) return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }
  }

  // The endings are written by writeMembershipFacts (after the relationship
  // write); here the decision is final.
  endedContactIds.push(...toEnd.map((r) => r.contact_id))
  return { counts, error: null, memberContactIds, endedContactIds, plan, activePlanByContact }
}

/**
 * Step 7a (ORGCONTACTS.1). One upsertContactStudio per contact this run
 * knows at the studio: kind member for a live subscriber, client otherwise;
 * source un1t_online; status active; first_seen_at from the client's
 * remote_created_at (the helper only ever moves it earlier); never
 * last_seen_at (a sync is not activity). Returns { member, client, failed }.
 */
async function writeContactStudios(db, { locationId, clients, contactIdOf, memberContactIds, endedContactIds, nowIso }) {
  const counts = { member: 0, client: 0, failed: 0 }
  const members = new Set(memberContactIds)
  const seen = new Set()
  const targets = []
  for (const c of clients) {
    const contactId = contactIdOf(c?.un1t_user_id)
    if (!contactId || seen.has(contactId)) continue
    seen.add(contactId)
    targets.push({ contactId, kind: members.has(contactId) ? 'member' : 'client', firstSeenAt: c.remote_created_at || nowIso })
  }
  for (const contactId of memberContactIds) {
    if (seen.has(contactId)) continue
    seen.add(contactId)
    targets.push({ contactId, kind: 'member', firstSeenAt: nowIso })
  }
  for (const contactId of endedContactIds) {
    if (!contactId || seen.has(contactId)) continue
    seen.add(contactId)
    targets.push({ contactId, kind: 'client', firstSeenAt: nowIso })
  }
  for (const t of targets) {
    const r = await upsertContactStudio(db, {
      contactId: t.contactId, locationId, kind: t.kind, source: 'un1t_online', status: 'active', firstSeenAt: t.firstSeenAt, nowIso,
    })
    if (r.ok) {
      counts[t.kind] += 1
    } else {
      counts.failed += 1
      logError('un1t-online-sync', 'contact_studios row not written', { locationId, contactId: t.contactId, kind: t.kind, error: r.error })
    }
  }
  return counts
}

/**
 * Step 7b (ORGCONTACTS.7, mig 770). The membership facts onto the relationship
 * rows: setMembershipFacts({ status: 'active', plan }) per live subscriber,
 * then ({ status: 'ended' }) per membership this run ended. Each is one
 * studio-scoped update (plus the guarded membership_since stamp on an
 * activation). Returns { activated, unchanged, ended, already_ended, rows_missing, failed }: unchanged = a live member whose row already says active with this plan (no write), already_ended = an ending that found the row no longer active (its date stands), rows_missing
 * = updates that touched no row (7a could not write it), failed = a failed
 * write; both logged, never thrown. `active` (live subscribers) stays reconcileMemberships'.
 */
async function writeMembershipFacts(db, { locationId, memberContactIds, plan, activePlanByContact = new Map(), endedContactIds, nowIso }) {
  // `active` stays reconcileMemberships' count of live subscribers; `activated` is the facts actually written.
  const out = { activated: 0, unchanged: 0, ended: 0, already_ended: 0, rows_missing: 0, failed: 0 }
  const writes = []
  for (const contactId of memberContactIds) {
    const want = plan.get(contactId) ?? 'Membership'
    // already active with this plan: nothing to write (no updated_at bump, no since stamp)
    if (activePlanByContact.has(contactId) && activePlanByContact.get(contactId) === want) { out.unchanged += 1; continue }
    writes.push({ contactId, status: 'active', plan: want })
  }
  for (const contactId of endedContactIds) writes.push({ contactId, status: 'ended' })
  for (const w of writes) {
    const r = await setMembershipFacts(db, { contactId: w.contactId, locationId, plan: w.plan ?? null, status: w.status, nowIso })
    if (!r.ok) {
      out.failed += 1
      logError('un1t-online-sync', 'membership facts not written', { locationId, contactId: w.contactId, status: w.status, error: r.error })
    } else if (!r.updated && w.status === 'ended') {
      // the row was no longer active when the ending landed (a run that overlapped, or a hand edit): its end date stands
      out.already_ended += 1
    } else if (!r.updated) {
      out.rows_missing += 1
      logError('un1t-online-sync', 'membership facts: no relationship row to carry them', { locationId, contactId: w.contactId, status: w.status })
    } else {
      out[w.status === 'active' ? 'activated' : 'ended'] += 1
    }
  }
  return out
}

/**
 * Record the run's outcome on the active un1t_online registry row, but only
 * while that row still holds the token this run used.
 *
 * The guard never puts the token itself in a filter: a PostgREST filter is a
 * URL query parameter, and request URLs are kept in the API logs. It matches
 * the token's non-secret fingerprint (config.token_fingerprint, a truncated
 * SHA-256 written by the connect route with the token) atomically in the
 * UPDATE. The token's id would not do: rotating a token keeps its id. A row
 * without a fingerprint falls back to reading the row and comparing the token
 * in memory before updating it by id.
 *
 * @returns {Promise<{ superseded?: true, error?: string }>} a zero-row result
 *   means the token was replaced (or the row deactivated) mid-run: superseded,
 *   logged at warn, never an error.
 */
async function updateConnection(db, locationId, patch, identity) {
  const superseded = () => {
    logWarn('un1t-online-sync', 'connection changed during the run; not recording this run\'s outcome on it', { locationId, status: patch.status })
    return { superseded: true }
  }
  const failed = (error) => {
    logError('un1t-online-sync', 'could not record the sync outcome on the connection', { locationId, status: patch.status, err: safeErr(error) })
    return { error: messageOf(error) }
  }

  let query = db
    .from('channel_connections')
    .update(patch)
    .eq('location_id', locationId)
    .eq('platform', PLATFORM)
    .eq('is_active', true)

  if (identity?.fingerprint) {
    query = query.eq('config->>token_fingerprint', identity.fingerprint)
  } else {
    const { data: rows, error: readError } = await db
      .from('channel_connections')
      .select('id, access_token')
      .eq('location_id', locationId)
      .eq('platform', PLATFORM)
      .eq('is_active', true)
    if (readError) return failed(readError)
    const row = (rows || []).find((r) => identity?.token && r.access_token === identity.token)
    if (!row) return superseded()
    query = query.eq('id', row.id)
  }

  const { data, error } = await query.select('id')
  if (error) return failed(error)
  if (!Array.isArray(data) || data.length === 0) return superseded()
  return {}
}

// ── SHAREDCONTACT.1: fresh signups → contact_created at this studio ──────────
//
// A client who became a contact of this studio on this run (inserted, or
// attached by email to a sibling studio's contact: one person per
// organisation, mig 712) is a new lead HERE, so this studio's contact_created
// sequences fire for them (Hatch Street's "New Lead – First Class Booking
// Nudge"). Before this nothing fired: the sync inserted contacts silently and
// a Stillorgan member who signed up at Hatch was never "created" at all.
//
// Three fences keep this off the mass-create path the trigger's own comment
// forbids: only a studio whose membership source IS un1t.online; only a
// client created upstream in the last SIGNUP_MAX_AGE_DAYS (an old account
// first matched today, or a backlog import, is not a new lead); and at most
// SIGNUP_TRIGGER_CAP a run (the rest are counted, never fired). A client
// attached to a contact that already lives at this studio was already new
// here when that contact was made, so it is not fired again.

export const SIGNUP_MAX_AGE_DAYS = 3
export const SIGNUP_TRIGGER_CAP = 25

/** Pure: which newly linked clients count as fresh signups at this studio. */
export function pickFreshSignups(newlyLinked, { locationId, nowIso, maxAgeDays = SIGNUP_MAX_AGE_DAYS }) {
  const now = Date.parse(nowIso)
  const floor = Number.isFinite(now) ? now - maxAgeDays * 86400000 : NaN
  const out = []
  const seen = new Set()
  let stale = 0
  let alreadyHere = 0
  for (const n of Array.isArray(newlyLinked) ? newlyLinked : []) {
    if (!n?.contactId || seen.has(n.contactId)) continue
    if (n.how === 'attached' && n.homeLocationId === locationId) { alreadyHere += 1; continue }
    const created = Date.parse(n.remoteCreatedAt || '')
    if (!Number.isFinite(created) || !Number.isFinite(floor) || created < floor) { stale += 1; continue }
    seen.add(n.contactId)
    out.push(n)
  }
  return { fresh: out, stale, alreadyHere }
}

async function fireSignupTriggers({ locationId, membershipSource, newlyLinked, nowIso }) {
  if (membershipSource !== 'un1t_online') return { skipped: 'membership_source' }
  if (!newlyLinked.length) return { fired: 0 }
  const { fresh, stale, alreadyHere } = pickFreshSignups(newlyLinked, { locationId, nowIso })
  const toFire = fresh.slice(0, SIGNUP_TRIGGER_CAP)
  const overCap = fresh.length - toFire.length
  if (overCap > 0) {
    logWarn('un1t-online-sync', 'more fresh signups than the per-run trigger cap; the rest were not fired', {
      locationId, fresh: fresh.length, cap: SIGNUP_TRIGGER_CAP,
    })
  }
  let fired = 0
  if (toFire.length) {
    const { triggerSequencesForContactCreated } = await import('./sequences/triggers.js')
    for (const n of toFire) {
      // Best-effort: the trigger swallows and logs its own failures.
      await triggerSequencesForContactCreated(n.contactId, { locationId, sourceRef: 'un1t_online_signup' })
      fired += 1
    }
  }
  return { fired, joined: toFire.filter((n) => n.homeLocationId !== locationId).length, stale, already_here: alreadyHere, over_cap: overCap }
}
