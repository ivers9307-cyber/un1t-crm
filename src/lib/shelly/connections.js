// SHELLY.7 — shelly_connections access. loadConnection returns the FULL row
// including auth_key and is SERVER ONLY: a route must never return that
// object. publicConnectionView is the only shape a route may return.
//
// The cross-org rule (spec "Tenancy"): the key's sha256 fingerprint is
// deliberately NOT unique — an owner with two studios may run both off one
// Shelly account — but a key already linked at a location in ANOTHER
// organisation is refused, and the refusal never names that organisation.
// Mirrors chooseTenantToBind (src/lib/xero/tenant-binding.js).
//
// EVERY DOUBTFUL CASE REFUSES. The two answers here are not symmetrical: a
// wrong "ok" links one tenant's studio to another tenant's Shelly account and
// hands them its relays; a wrong "other_org" costs an owner a support message.
// So a holder whose organisation cannot be established — the `locations`
// embed missing, a blank org id on either side — is treated as foreign, and
// the refusal carries nothing but the reason.

import { createShellyClient } from './client'

// The columns a route may read. No auth_key, and no auth_key_fingerprint
// either: the fingerprint is a sha256 OF the key, so publishing it turns
// "which account is this?" into an offline check anyone holding a candidate
// key can run. publicConnectionView narrows this further still — this
// constant only keeps the secrets out of the round trip.
const NON_SECRET = 'id, location_id, host, key_hint, status, last_ok_at, last_error, last_error_at, linked_by, created_at, updated_at'

// The most locations one Shelly account could plausibly serve, several times
// over. It is a guard, not a page size: the spec caps the estate at 100
// connections, so a fingerprint held by more than 50 of them is not a real
// account, it is a bug or an attack. Reaching it is reported (see `capped`)
// rather than silently answered as if those were all the holders there are.
export const FINGERPRINT_ROW_CAP = 50

/**
 * Decide whether a pasted key may be linked at `locationId`.
 *
 * @param rows  findFingerprintRows() output — every connection already on this
 *              fingerprint, each with its location's organisation and name.
 * @returns {{ok: true, shared_with: string[]} | {ok: false, reason: 'other_org'}}
 *          `shared_with` names the SAME-ORG siblings, for copy like "this key
 *          is also linked at Hatch Street". The refusal deliberately carries
 *          no name, no id and no count.
 */
export function classifyFingerprintClash(rows, organizationId, locationId) {
  const shared_with = []
  for (const r of rows || []) {
    // Our own row is a re-paste, not a clash. Guarded on a truthy locationId:
    // without it a caller that passed undefined would match undefined ===
    // undefined against a row with no location_id and skip a real holder.
    if (locationId && r?.location_id === locationId) continue
    // Blank organisation ids never match each other. `!==` alone would read
    // undefined === undefined as "same organisation", so a route that forgot
    // to carry the org id — or a select that dropped the embed — would wave
    // through every foreign key on the estate, and nothing would look wrong.
    const sameOrg = Boolean(organizationId) && r?.locations?.organization_id === organizationId
    if (!sameOrg) return { ok: false, reason: 'other_org' }
    shared_with.push(r.locations?.name || 'another location')
  }
  return { ok: true, shared_with }
}

/**
 * Every connection already holding this key fingerprint.
 *
 * @returns {{ok: true, rows: Array, capped?: true} | {ok: false, error: string}}
 *          CALLER OBLIGATION: `capped` means the read hit FINGERPRINT_ROW_CAP,
 *          so an unseen row could be the foreign holder that should have
 *          refused the link. Treat it as a refusal, not as a full answer.
 */
export async function findFingerprintRows(db, fingerprint) {
  const { data, error } = await db
    .from('shelly_connections')
    .select('location_id, locations(organization_id, name)')
    .eq('auth_key_fingerprint', fingerprint)
    .limit(FINGERPRINT_ROW_CAP)
  if (error) return { ok: false, error: error.message }
  const rows = data || []
  if (rows.length >= FINGERPRINT_ROW_CAP) return { ok: true, rows, capped: true }
  return { ok: true, rows }
}

// Full row, key included. Server-side callers only (cron, toggle, discover).
// `.maybeSingle()` is right because location_id is UNIQUE — the query returns
// 0 or 1 rows by construction, and 0 is the normal "not connected" answer
// rather than an error.
export async function loadConnection(db, locationId) {
  const { data, error } = await db
    .from('shelly_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data) return { ok: false, reason: 'not_connected' }
  return { ok: true, connection: data }
}

// What a route reads. Same 0-or-1 UNIQUE argument for `.maybeSingle()` as
// loadConnection, and the row never carries the key in the first place.
export async function loadPublicConnection(db, locationId) {
  const { data, error } = await db.from('shelly_connections').select(NON_SECRET).eq('location_id', locationId).maybeSingle()
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data) return { ok: false, reason: 'not_connected' }
  return { ok: true, connection: publicConnectionView(data) }
}

// An ALLOWLIST, never a spread of the row minus a few fields: a column added
// to the table later must not start appearing in a response because nobody
// remembered to subtract it. Safe against a full row too, which is why
// loadConnection's output can be passed straight in.
export function publicConnectionView(conn) {
  return {
    host: conn?.host ?? null,
    key_hint: conn?.key_hint ?? null,
    // Derived from the hint, not hard-coded true. The hint is the only
    // evidence of a key that this projection HAS (auth_key is never selected),
    // so deriving it from anything else would make the field mean different
    // things depending on which loader called. A blank hint under-claims —
    // the operator is asked to paste a key that may already be there, which
    // is a wasted minute; claiming true for a row with no key strands them
    // on a connection the UI says is configured and the cron cannot use.
    has_auth_key: Boolean(conn?.key_hint),
    status: conn?.status ?? null,
    last_ok_at: conn?.last_ok_at ?? null,
    last_error: conn?.last_error ?? null,
    last_error_at: conn?.last_error_at ?? null,
  }
}

/**
 * One v1 all_status call: validates a pasted key before it is saved.
 *
 * The client's `kind` is passed through VERBATIM rather than re-tagged here,
 * so there is one vocabulary for a Shelly failure in this codebase. That
 * matters to the caller, because only `auth` means "the key is wrong":
 * `config` is a bad host and no request was made, `network`/`http` are the
 * cloud being unreachable, and `rate_limited` is most likely the OWNER'S OTHER
 * STUDIO mid-reconcile on the same 1 req/sec budget. Refusing a good key, or
 * stamping status='error', on any of those is a false accusation.
 *
 * @returns {{ok: true, deviceCount: number} | {ok: false, kind: string, statusCode: number}}
 */
export async function probeConnection(conn, { makeClient = createShellyClient } = {}) {
  const res = await makeClient(conn).allStatus()
  if (!res.ok) return { ok: false, kind: res.kind, statusCode: res.statusCode }
  // v1 devices_status is an OBJECT KEYED BY DEVICE ID, and the count is only
  // meaningful as "ids we could read". An array is not that shape, and
  // Object.keys would happily count its indices — reporting "2 devices found"
  // off a body discovery can never get an id out of. Anything unrecognised
  // counts 0; the probe's verdict is the key, not the inventory.
  const devices = res.body?.data?.devices_status
  const countable = !!devices && typeof devices === 'object' && !Array.isArray(devices)
  return { ok: true, deviceCount: countable ? Object.keys(devices).length : 0 }
}
