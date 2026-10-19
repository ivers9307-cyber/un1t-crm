// UN1TSYNC.6 — the un1t.online → CRM sync engine for one studio.
//
// One run is a FULL pull (the API ignores `updated_since`), in this order:
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
//      The events are then projected into class_occurrences (UN1TCLASS.2),
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
//   7. Reconcile contact_memberships (source 'un1t_online_api' at this
//      location only; the operator export's rows are never touched): a
//      contact with an active subscription is upserted active; an active row
//      whose contact no longer has one is ENDED, never deleted.
//   8. Record the outcome on the connection; 9. close the run row.
//
// NEVER DELETES. Nothing in a run issues a delete: a row absent from a pull
// stays, and a membership absent from a pull is ended.
//
// Two guards on step 7, because an ended membership is customer-facing (event
// member pricing reads contact_memberships) and a wrongly ended one charges a
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

const MEMBERSHIP_SOURCE = 'un1t_online_api'
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
    client = clientFactory({ token: conn.accessToken })
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
  for (const path of UN1T_LISTS) {
    const meta = LIST_META[path]
    let res
    try {
      res = await client.listAll(path)
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
    counts.history = await measureHistory(db, { locationId, mapped, nowIso })
    if (Object.values(counts.history).some((h) => h.absent_from_pull > 0)) {
      logInfo('un1t-online-sync', 'the mirror holds rows this pull did not return (rolling window or upstream delete)', {
        locationId, runId, history: counts.history,
      })
    }

    // 7. Memberships.
    const membership = await reconcileMemberships(db, {
      locationId,
      organizationId,
      subscriptions: mapped.un1t_subscriptions,
      contactIdOf,
      resolverErrors: resolved.errors || [],
      nowIso,
    })
    counts.memberships = membership.counts
    if (membership.error) {
      const msg = `un1t.online sync failed writing contact_memberships: ${membership.error}`
      return failure('db', msg, errorPatch(msg, tokenFields))
    }
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
  const warning = unmatched > 0
    ? `Synced, but ${unmatched} un1t.online member${unmatched === 1 ? '' : 's'} could not be matched to contacts (${failedN} failed, ${conflictN} conflicts, ${ambiguousN} ambiguous emails).`
    : null
  return finish({
    ok: true,
    firstError: null,
    connectionPatch: { status: 'connected', last_ok_at: nowIso, last_error: warning, ...tokenFields },
  })
}

/**
 * Step 6c. Per dated table: rows held at this location that this pull did not
 * return (synced_at older than this run's start), and the oldest row pulled.
 * @returns {Promise<Record<string, { absent_from_pull: number|null, oldest_pulled: string|null, error?: string }>>}
 */
async function measureHistory(db, { locationId, mapped, nowIso }) {
  const out = {}
  for (const [table, dateCol] of Object.entries(HISTORY_TABLES)) {
    const rows = Array.isArray(mapped[table]) ? mapped[table] : []
    let oldest = null
    for (const r of rows) {
      const v = r[dateCol]
      if (typeof v === 'string' && v !== '' && (oldest === null || v < oldest)) oldest = v
    }
    const { count, error } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .lt('synced_at', nowIso)
    out[table] = error
      ? { absent_from_pull: null, oldest_pulled: oldest, error: messageOf(error) }
      : { absent_from_pull: Number.isFinite(count) ? count : null, oldest_pulled: oldest }
  }
  return out
}

/**
 * Step 7. Returns { counts, error } where error is a message or null.
 * first_seen_at is never in the upsert payload, so its column default sets it
 * on insert only and a re-activation keeps the original date.
 */
async function reconcileMemberships(db, { locationId, organizationId, subscriptions, contactIdOf, resolverErrors, nowIso }) {
  const counts = { active: 0, ended: 0, skipped_no_contact: 0 }

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

  const payload = [...best.entries()].map(([contactId, sub]) => ({
    organization_id: organizationId,
    location_id: locationId,
    contact_id: contactId,
    source: MEMBERSHIP_SOURCE,
    plan_name: (sub.product_title && sub.product_title.trim()) || 'Membership',
    status: 'active',
    ended_at: null,
    last_seen_at: nowIso,
    updated_at: nowIso,
  }))
  for (const chunk of chunks(payload, CHUNK)) {
    const { error } = await db
      .from('contact_memberships')
      .upsert(chunk, { onConflict: 'contact_id,location_id,source' })
    if (error) return { counts, error: messageOf(error) }
    counts.active += chunk.length
  }

  // Active rows for this source here, read in full (1,000-row pages).
  const activeRows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contact_memberships')
      .select('id, contact_id')
      .eq('location_id', locationId)
      .eq('source', MEMBERSHIP_SOURCE)
      .eq('status', 'active')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) return { counts, error: `reading active memberships: ${messageOf(error)}` }
    const rows = Array.isArray(data) ? data : []
    activeRows.push(...rows)
    if (rows.length < PAGE) break
  }

  let toEnd = activeRows.filter((r) => !best.has(r.contact_id))
  if (toEnd.length === 0) return { counts, error: null }

  if (subscriptions.length === 0) {
    counts.end_skipped = 'no_subscriptions_pulled'
    counts.would_end = toEnd.length
    logWarn('un1t-online-sync', 'not ending memberships: the pull carried no subscriptions', { locationId, wouldEnd: toEnd.length })
    return { counts, error: null }
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
      return { counts, error: null }
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
        return { counts, error: null }
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
    if (toEnd.length === 0) return { counts, error: null }
  }

  for (const ids of chunks(toEnd.map((r) => r.id), CHUNK)) {
    const { data, error } = await db
      .from('contact_memberships')
      .update({ status: 'ended', ended_at: nowIso, updated_at: nowIso })
      .in('id', ids)
      .eq('location_id', locationId)
      .eq('source', MEMBERSHIP_SOURCE)
      .eq('status', 'active')
      .select('id')
    if (error) return { counts, error: `ending memberships: ${messageOf(error)}` }
    // Fewer rows than asked = a row changed under us; not an error.
    counts.ended += Array.isArray(data) ? data.length : 0
  }
  return { counts, error: null }
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
