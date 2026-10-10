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
