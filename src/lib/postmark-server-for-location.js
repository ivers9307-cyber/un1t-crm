// W1.E4 — which Postmark SERVER a location's mail lives on.
//
// A Postmark suppression list is per (server, stream). An org with a LIVE
// tenant_email_domains row (mig 427) sends from its OWN server — that is what
// resolveEmailSender (tenant-email.js) hands the send path — so the consent
// surfaces (unsubscribe, preference centre, the public forms, the host list)
// and the consent-drift reconciliation must push and lift suppressions on
// THAT server, or the "second, independent refusal" PMSUPP.1 built is a
// refusal on a server the tenant's mail never touches.
//
// serverTokenForLocation(db, locationId) answers that question for one
// location: the org's live server token, or null = the global server. It is
// deliberately a thin wrapper over resolveEmailSender rather than a second
// resolver: ONE reading of "which server does this location send from", ONE
// 60 s cache (SENDER_CACHE_TTL_MS in tenant-email.js), so a suppression can
// never land on a different server than the send it exists to refuse.
//
// FAIL SAFE: never throws, null on any error. Every caller runs beside a
// customer's opt-out and must never fail it; null routes to the global server,
// which is exactly where every send goes when the resolver cannot find a live
// tenant row.
//
// SECRET: the returned token is the org's live sending credential. It is
// returned to the caller's memory for the X-Postmark-Server-Token header and
// nothing else — never log it, never return it from a route.

import { resolveEmailSender } from './tenant-email'

/**
 * The Postmark server token for a location's org, or null for the global
 * server. NEVER throws.
 * @param {object} db - service-role client (createServerClient())
 * @param {string|null|undefined} locationId
 * @returns {Promise<string|null>}
 */
export async function serverTokenForLocation(db, locationId) {
  if (!db || !locationId) return null
  try {
    const sender = await resolveEmailSender(db, locationId)
    return sender?.serverToken || null
  } catch {
    return null
  }
}

/**
 * Every LIVE tenant Postmark server (one per org), for a job that must visit
 * each server in turn (the consent-drift reconciliation). Rows with no token
 * are skipped — a live row should always carry one (senderFromRow treats a
 * token-less live row as the global default for the same reason).
 *
 * Returns `{ servers, error }`, never throws: a caller must be able to tell
 * "no tenant has its own server" from "we could not ask", because the second
 * read as the first would silently leave every tenant unreconciled.
 *
 * @param {object} db - service-role client
 * @returns {Promise<{ servers: Array<{ organizationId: string, serverToken: string }>, error: string|null }>}
 */
export async function listLiveTenantServers(db) {
  try {
    const { data, error } = await db
      .from('tenant_email_domains')
      .select('organization_id, postmark_server_token')
      .eq('status', 'live')
    if (error) return { servers: [], error: error.message || String(error) }
    const servers = (data || [])
      .filter(r => r?.organization_id && typeof r.postmark_server_token === 'string' && r.postmark_server_token)
      .map(r => ({ organizationId: r.organization_id, serverToken: r.postmark_server_token }))
    return { servers, error: null }
  } catch (err) {
    return { servers: [], error: err?.message || String(err) }
  }
}

/**
 * The Postmark server a HOST's mail goes out on — null = the global server,
 * for every host, today.
 *
 * ┌─ WHY NOT serverTokenForLocation(db, host.anchor_location_id) ────────────┐
 * │ Host campaign sends ride the GLOBAL server: host-campaign-queue.js:227    │
 * │ calls sendEmail with no locationId, and the host's own stream            │
 * │ (event_hosts.postmark_stream_id) exists only on that server. Resolving a │
 * │ host suppression to its org's tenant server would push to a server that  │
 * │ has no such stream (Postmark 422) and never refuses a host send: the     │
 * │ suppression would silently never land. One reading of "which server does │
 * │ host mail use" lives here so the two can never disagree.                 │
 * │                                                                          │
 * │ FLIP THIS to `serverTokenForLocation(db, host.anchor_location_id)` in    │
 * │ the SAME PR that (a) passes `locationId: host.anchor_location_id` to the │
 * │ host send in host-campaign-queue.js and (b) creates the host's stream on │
 * │ the tenant server (ensureTenantServerStreams, postmark-account.js).      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Takes the host row (not a location id) so the flip is a one-line change
 * for every caller. `db` is unused today and part of the signature for the
 * same reason. NEVER throws.
 *
 * @param {object} db - service-role client
 * @param {{ anchor_location_id?: string|null }|null} host - an event_hosts row
 * @returns {Promise<string|null>}
 */
export async function hostServerToken(db, host) {
  if (!db || !host) return null
  return null
}
