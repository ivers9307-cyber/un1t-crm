// ZOOMSYNC.1 — CRM → the directory we want Zoom to hold.
//
// Owns four rules: the ORGANISATION BOUNDARY, ClassPass is excluded, numbers
// are normalised to E.164, and where two profiles share a number the OLDEST
// profile supplies the name.
//
// ZOOMSYNC.2 — the boundary is the rule that is not about phone numbers.
// `contacts` is a shared multi-tenant table: UN1T Group's gyms live in it, but
// so do CCF Autos, Givers Consultancy, and every future Repset tenant. The Zoom
// Phone external-contacts directory is the opposite — ONE account-wide
// directory, on UN1T's Zoom account, readable by every Zoom Phone user on it.
// An unfiltered read publishes one company's customers onto another company's
// staff handsets. CCF Autos is a separate business with its own customers and
// its own data-controller relationship, and it already runs a `car_enquiries`
// funnel; it holds no phone-bearing contacts today, which is the only reason
// this shipped as a latent problem rather than a live one.
//
// `contacts` carries no organization_id (only location_id, mig 004), so the
// boundary resolves through locations.organization_id (mig 079).
//
// It FAILS CLOSED. A missing org id, or an org resolving to no locations,
// aborts the build rather than returning an empty Map: empty desired reads to
// diffContacts() as "delete every entry", and applyDeletionGuard() is meant to
// be the second line of defence, not the first.

import { normaliseForZoom } from './normalise-phone'
import { e164Rejection } from './publishable-e164'

const PAGE_SIZE = 1000       // PostgREST caps every select at 1000 rows
const HARD_LIMIT = 40_000    // ~6.7k today; crossing this means streaming, not a bigger number
const SELECT_COLS = 'id, first_name, last_name, phone, lead_source, created_at'

/**
 * ZOOMSYNC.2 — location ids for the synced organisation, or null when the
 * boundary cannot be established.
 *
 * Deliberately NOT orgLocationIds() from src/lib/api-auth.js, despite the
 * identical lookup: that module is the request-auth layer (it imports
 * next/server, getCurrentUser and createServerClient, and nothing else in
 * src/lib imports it), and this one fails closed where that one returns [].
 * One duplicated query beats dragging that graph into a cron lib.
 */
async function syncScopeLocationIds(db, orgId) {
  // Supabase builders are thenables, not Promises — no .catch() here.
  const { data, error } = await db
    .from('locations')
    .select('id')
    .eq('organization_id', orgId)

  if (error || !Array.isArray(data) || data.length === 0) return null
  return data.map((l) => l.id)
}

/**
 * Date.parse(...) returns NaN for a genuinely unparseable/missing value, but
 * returns the number 0 for a legitimately-valid Unix-epoch timestamp — and 0
 * is falsy. A `Date.parse(x) || FALLBACK` guard would conflate the two,
 * shoving a real epoch date to "effectively newest" instead of letting it win
 * as the oldest. `contacts.created_at` is a nullable timestamptz, so a bad
 * backfill or import leaving a row at the epoch is a real possibility this
 * must still resolve correctly. Test with Number.isNaN, not truthiness.
 */
function parsedTime(value) {
  const t = Date.parse(value ?? '')
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

/**
 * Oldest profile wins. `contacts.id` breaks a created_at tie so two rows
 * written in the same transaction cannot flip the name between runs.
 */
export function pickWinner(a, b) {
  const ta = parsedTime(a.created_at)
  const tb = parsedTime(b.created_at)
  if (ta !== tb) return ta < tb ? a : b
  return String(a.id) < String(b.id) ? a : b
}

function nameOf(row) {
  return [row.first_name, row.last_name]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.collectRejects] — also return the rejected rows with a
 *   reason code. Off by default so the nightly run pays nothing for it. This is
 *   deliberately the SAME code path the sync uses: a separate "which rows would
 *   be skipped" query is a second source of truth that drifts at the first
 *   normaliser change.
 * @returns {Promise<{ok: true, desired: Map<string, {name: string, contactId: string}>,
 *                    invalid: Set<string>, stats: object, rejects?: object[]}
 *                 | {ok: false, error: string}>}
 *   `invalid` is every E.164 a scanned contact produced that Zoom would refuse.
 *   It is NOT the complement of `desired` — a number in neither set is simply
 *   gone from the CRM, which is a legitimate delete. See reconcile.js.
 */
export async function buildDesiredContacts(db, { collectRejects = false } = {}) {
  // ZOOMSYNC.2 — the boundary first, before a single contact row is read.
  const orgId = process.env.ZOOM_SYNC_ORGANIZATION_ID
  if (!orgId) {
    return { ok: false, error: 'ZOOM_SYNC_ORGANIZATION_ID is unset — refusing to read contacts unscoped' }
  }
  const locationIds = await syncScopeLocationIds(db, orgId)
  if (!locationIds) {
    return { ok: false, error: `organization ${orgId} resolved to no locations — refusing to sync an empty desired set` }
  }

  const stats = {
    scanned: 0, excludedClassPass: 0, rejected: 0, invalidE164: 0, noName: 0, collapsed: 0,
    orgLocations: locationIds.length,
  }
  const rejects = collectRejects ? [] : null
  const note = (row, reason, detail = null) => {
    if (rejects) {
      rejects.push({
        id: String(row.id), name: nameOf(row), phone: row.phone ?? null, reason,
        ...(detail ? { detail } : {}),
      })
    }
  }
  const winners = new Map() // e164 → row
  // ZOOMSYNC.4 — numbers that read as a phone number but that Zoom will not
  // hold. Returned alongside `desired` because dropping them is NOT the end of
  // it: the reconcile diffs desired against Zoom, so a key that silently
  // vanishes from desired becomes a DELETE against any entry already created
  // under it. reconcile.js protects these keys explicitly; see diffContacts.
  const invalid = new Set()

  let pageStart = 0
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    // Supabase builders are thenables, not Promises — no .catch() here.
    const { data: page, error } = await db
      .from('contacts')
      .select(SELECT_COLS)
      // The tenant boundary. Also drops location_id IS NULL, since `IN` never
      // matches NULL — a contact with no provable tenant is not published.
      .in('location_id', locationIds)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)

    if (error) return { ok: false, error: `contact load: ${error.message}` }
    if (!Array.isArray(page) || page.length === 0) break

    for (const row of page) {
      stats.scanned++

      if (String(row.lead_source ?? '').toLowerCase() === 'classpass') {
        stats.excludedClassPass++
        continue
      }
      const e164 = normaliseForZoom(row.phone)
      if (!e164) {
        stats.rejected++
        note(row, String(row.phone ?? '').trim() ? 'unparseable' : 'no_phone')
        continue
      }
      // ZOOMSYNC.4 — shape was never the same question as validity. Before this
      // check the four numbers in the 06-Aug runtime log were enqueued nightly
      // and 400'd nightly, forever.
      const rejection = e164Rejection(e164)
      if (rejection) {
        stats.invalidE164++
        invalid.add(e164)
        note(row, 'invalid_e164', rejection)
        continue
      }
      if (!nameOf(row)) { stats.noName++; note(row, 'no_name'); continue }

      const held = winners.get(e164)
      if (!held) { winners.set(e164, row); continue }
      stats.collapsed++
      winners.set(e164, pickWinner(held, row))
    }

    if (page.length < PAGE_SIZE) break
    pageStart += PAGE_SIZE
    if (pageStart >= HARD_LIMIT) break
  }

  const desired = new Map()
  for (const [e164, row] of winners) {
    desired.set(e164, { name: nameOf(row), contactId: String(row.id) })
  }
  return { ok: true, desired, invalid, stats, ...(rejects ? { rejects } : {}) }
}
