// INTEG-B3 — route-side orchestration for the tenant email-domain wizard
// (server-per-tenant). Kept OUT of src/lib/tenant-email.js (the send-path
// resolver, which must not import auth/next) — this module is imported only
// by the /api/settings/email-domain routes, so it may pull in auth.
//
// It owns: org-target resolution (owner-of-org / master, cross-org 404),
// the raw row load (service-role — the row carries the SECRET server token,
// callers redact via tenantEmailStatePayload before returning), and the
// Postmark provisioning + verify orchestration (idempotent, persists ids +
// token the moment they are minted).

import { getOwnerOrganizationIds } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import {
  createTenantServer,
  createTenantDomain,
  getTenantDomain,
  verifyTenantDomainDkim,
  verifyTenantReturnPath,
  domainIsFullyVerified,
} from '@/lib/postmark-account'

/**
 * Resolve the target org for a caller (mirrors resolveBillingOrgId):
 *   - master:  any org (?organization_id, defaults to active)
 *   - owner:   orgs they own ONLY (getOwnerOrganizationIds — includes
 *              SAAS-4 org admins); a foreign organization_id resolves to
 *              { notFound: true } so ids can't be existence-probed.
 * Role gating (owner/master) is done by the route BEFORE calling this.
 * @returns {{ orgId?: string|null, notFound?: boolean }}
 */
export function resolveEmailDomainOrgId(user, requested) {
  if (user.role === 'master') {
    return { orgId: requested || user.activeOrganization?.id || null }
  }
  const owned = getOwnerOrganizationIds(user)
  const target = requested || user.activeOrganization?.id || owned[0] || null
  if (!target) return { orgId: null }
  if (!owned.includes(target)) return { notFound: true }
  return { orgId: target }
}

/**
 * Load the raw tenant_email_domains row for an org (service-role client).
 * INCLUDES the secret server token — callers MUST redact via
 * tenantEmailStatePayload before returning it to a client.
 */
export async function loadEmailDomainRow(db, orgId) {
  const { data } = await db
    .from('tenant_email_domains')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle()
  return data || null
}

// Upsert (org is PK) a partial patch; always stamps updated_at. On an
// existing row PostgREST updates only the provided columns, so created_*
// and the untouched provisioning fields survive.
async function upsertRow(db, orgId, patch) {
  const { data, error } = await db
    .from('tenant_email_domains')
    .upsert(
      { organization_id: orgId, updated_at: new Date().toISOString(), ...patch },
      { onConflict: 'organization_id' }
    )
    .select('*')
    .single()
  if (error) throw new Error(`tenant_email_domains persist failed: ${error.message}`)
  return data
}

// Fold a shaped Postmark domain response into the row's verification
// state. status → 'live' only when BOTH records verify; a disabled/failed
// row is not silently reactivated by a verify pass.
function persistDomainState(db, orgId, row, shaped) {
  const status = domainIsFullyVerified(shaped)
    ? 'live'
    : (row.status === 'disabled' || row.status === 'failed' ? row.status : 'verifying')
  return upsertRow(db, orgId, {
    dkim_pending_host: shaped.dkimPendingHost ?? row.dkim_pending_host,
    dkim_pending_value: shaped.dkimPendingValue ?? row.dkim_pending_value,
    dkim_verified: shaped.dkimVerified,
    return_path_domain: shaped.returnPathDomain ?? row.return_path_domain,
    return_path_cname_value: shaped.returnPathCnameValue ?? row.return_path_cname_value,
    return_path_verified: shaped.returnPathVerified,
    status,
    last_error: null,
  })
}

/**
 * Provision (or idempotently re-read) an org's Postmark server + sending
 * domain. IDEMPOTENT: a fully-provisioned org never spawns a second server
 * or domain whatever is posted — it re-reads Postmark and returns current
 * state. The server id + token are persisted the MOMENT they are minted so
 * a failure between the two Postmark calls resumes on the row, never
 * duplicating the server.
 *
 * @param {object} db - service-role client
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.orgName    - names the server in the Postmark UI
 * @param {string} args.sendingDomain - bare, sanitized (e.g. mail.gymx.com)
 * @param {string} [args.fromLocal]   - local-part (default 'hello')
 * @param {string} [args.fromName]
 * @param {string} [args.createdBy]
 * @returns {Promise<object>} the persisted row (raw — caller redacts)
 */
export async function provisionEmailDomain(db, { orgId, orgName, sendingDomain, fromLocal, fromName, createdBy }) {
  let row = await loadEmailDomainRow(db, orgId)

  // Already fully provisioned → idempotent re-read, no new Postmark resources.
  if (row?.postmark_server_id && row?.postmark_domain_id) {
    const shaped = await getTenantDomain(row.postmark_domain_id)
    return persistDomainState(db, orgId, row, shaped)
  }

  // Step 1 — server. Persist id + token the moment they are minted.
  if (!row?.postmark_server_id) {
    const server = await createTenantServer(orgName)
    if (!server.id || !server.serverToken) {
      throw new Error('Postmark did not return a server id/token.')
    }
    row = await upsertRow(db, orgId, {
      postmark_server_id: server.id,
      postmark_server_token: server.serverToken,
      status: 'pending',
      created_by: createdBy || null,
      last_error: null,
    })
  }

  // Step 2 — domain. Reuse an existing domain id, else create it.
  const fromEmail = `${fromLocal || 'hello'}@${sendingDomain}`
  let shaped
  if (row.postmark_domain_id) {
    shaped = await getTenantDomain(row.postmark_domain_id)
  } else {
    shaped = await createTenantDomain(sendingDomain)
    if (!shaped.id) throw new Error('Postmark did not return a domain id.')
  }

  return upsertRow(db, orgId, {
    postmark_domain_id: shaped.id,
    sending_domain: sendingDomain,
    from_email: fromEmail,
    from_name: fromName || null,
    dkim_pending_host: shaped.dkimPendingHost,
    dkim_pending_value: shaped.dkimPendingValue,
    dkim_verified: shaped.dkimVerified,
    return_path_domain: shaped.returnPathDomain,
    return_path_cname_value: shaped.returnPathCnameValue,
    return_path_verified: shaped.returnPathVerified,
    status: domainIsFullyVerified(shaped) ? 'live' : 'verifying',
    last_error: null,
  })
}

/**
 * Ask Postmark to re-check DKIM + Return-Path, read the result, persist it,
 * and flip status → 'live' when both verify. IDEMPOTENT — re-running once
 * live keeps it live.
 *
 * @returns {Promise<{ row?: object, notProvisioned?: boolean, error?: string }>}
 */
export async function verifyEmailDomain(db, orgId) {
  const row = await loadEmailDomainRow(db, orgId)
  if (!row?.postmark_domain_id) return { notProvisioned: true }

  // Best-effort re-checks: Postmark rejects these while DNS is still
  // wrong, so the getTenantDomain read below is the source of truth.
  try { await verifyTenantDomainDkim(row.postmark_domain_id) } catch (e) {
    logWarn('tenant-email-domain', 'verifyDkim rejected', { err: e?.message })
  }
  try { await verifyTenantReturnPath(row.postmark_domain_id) } catch (e) {
    logWarn('tenant-email-domain', 'verifyReturnPath rejected', { err: e?.message })
  }

  let shaped
  try {
    shaped = await getTenantDomain(row.postmark_domain_id)
  } catch (e) {
    await upsertRow(db, orgId, { last_error: e?.message || 'domain read failed' })
    return { error: e?.message || 'Could not read the sending domain.' }
  }
  return { row: await persistDomainState(db, orgId, row, shaped) }
}
