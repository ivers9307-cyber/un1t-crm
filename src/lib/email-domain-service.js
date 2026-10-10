// INTEG-B3 — route-side orchestration for the tenant email-domain wizard
// (server-per-tenant). Kept OUT of src/lib/tenant-email.js (the send-path
// resolver, which must not import auth/next) — this module is imported only
// by the /api/settings/email-domain routes, so it may pull in auth.
//
// It owns: org-target resolution (organisation admin / master, cross-org 404),
// the raw row load (service-role — the row carries the SECRET server token,
// callers redact via tenantEmailStatePayload before returning), and the
// Postmark provisioning + verify orchestration (idempotent, persists ids +
// token the moment they are minted).

import { resolveAdminOrgId } from '@/lib/org-admin'
import { logWarn, logError } from '@/lib/log'
import {
  createTenantServer,
  createTenantDomain,
  getTenantDomain,
  verifyTenantDomainDkim,
  verifyTenantReturnPath,
  domainIsFullyVerified,
  ensureTenantServerStreams,
  ensureTenantServerWebhooks,
} from '@/lib/postmark-account'

/**
 * Resolve the target org for a caller (mirrors resolveBillingOrgId):
 *   - master:     any org (?organization_id, defaults to active)
 *   - org admin:  their admin orgs ONLY (org_admin grant, mig 417; C18
 *                 ORGROLE.1 — a studio owner is not an org admin); a foreign
 *                 organization_id resolves to { notFound: true } so ids
 *                 can't be existence-probed; nothing to act on is
 *                 { orgId: null }.
 * The routes' coarse gate (isOrgAdminSomewhere) runs BEFORE calling this.
 * @returns {{ orgId?: string|null, notFound?: boolean }}
 */
export function resolveEmailDomainOrgId(user, requested) {
  // C18 ORGROLE.1 — organisation admins only (master or an org_admin grant).
  return resolveAdminOrgId(user, requested)
}

// CHANNELREAD.1 — what a failed tenant_email_domains read says to operators.
export const EMAIL_DOMAIN_READ_FAILED = 'Could not read the email domain just now, so nothing was changed. Try again.'

/**
 * Load the raw tenant_email_domains row for an org (service-role client).
 * INCLUDES the secret server token — callers MUST redact via
 * tenantEmailStatePayload before returning it to a client.
 */
export async function loadEmailDomainRow(db, orgId) {
  const { data, error } = await db
    .from('tenant_email_domains')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle()
  // CHANNELREAD.1 — a failed read is not "no domain". Returning null here
  // showed the set-up wizard over a provisioned domain, and made
  // provisionEmailDomain mint a SECOND Postmark server and overwrite the
  // stored server id + token. Callers turn the throw into a 500/502.
  // The message is plain copy because it reaches operators: the POST route
  // stores it as last_error and answers it in its 502. The Postgres text is
  // logged here, structurally, and never shown.
  if (error) {
    logError('tenant-email-domain', 'tenant_email_domains read failed', { orgId, err: error.message })
    throw new Error(EMAIL_DOMAIN_READ_FAILED)
  }
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
// `lastError` is the webhook step's message when that step failed on this
// pass (W1.E3) — it must survive this write so the status endpoint shows it.
function persistDomainState(db, orgId, row, shaped, lastError = null) {
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
    last_error: lastError,
  })
}

/**
 * W1.E3 — make sure the org's Postmark server carries the broadcast stream
 * and the six-trigger webhooks, then stamp webhooks_registered_at (mig 718).
 * Idempotent: a stamped row is left alone; a NULL stamp (never done, or a
 * failed earlier pass) runs both helpers again, and they only create what is
 * missing. A failure is NOT fatal to provisioning or verification: it is
 * logged structurally and returned as `error` so the caller writes it to
 * last_error, and the stamp stays NULL so the next provision OR verify call
 * retries. The server token is read off the row and never logged.
 *
 * @returns {Promise<{ row: object, error: string|null }>}
 */
async function ensureServerWebhooksRecorded(db, orgId, row) {
  if (!row?.postmark_server_token || row.webhooks_registered_at) return { row, error: null }
  try {
    await ensureTenantServerStreams(row.postmark_server_token)
    await ensureTenantServerWebhooks(row.postmark_server_token)
  } catch (e) {
    const message = e?.message || 'Postmark webhook registration failed.'
    // The raw message goes to the structured log for ops; what reaches
    // last_error is rendered in red to the org admin by EmailDomainWizard,
    // so it says what did not happen and what to press.
    logWarn('tenant-email-domain', 'server streams/webhook registration failed; will retry on the next provision or verify', { orgId, err: message })
    return { row, error: `Event webhooks were not registered on the sending server (${message}). Press Verify to retry.` }
  }
  const stamped = await upsertRow(db, orgId, { webhooks_registered_at: new Date().toISOString() })
  return { row: stamped, error: null }
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

  // Already fully provisioned → idempotent re-read, no new Postmark resources
  // (but a NULL webhooks stamp is retried — W1.E3).
  if (row?.postmark_server_id && row?.postmark_domain_id) {
    const hooks = await ensureServerWebhooksRecorded(db, orgId, row)
    const shaped = await getTenantDomain(row.postmark_domain_id)
    return persistDomainState(db, orgId, hooks.row, shaped, hooks.error)
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

  // Step 1b — W1.E3: streams + webhooks on the server, with the token just
  // persisted. Its own try (inside the helper): a failure records last_error
  // below and never blocks the domain.
  const hooks = await ensureServerWebhooksRecorded(db, orgId, row)
  row = hooks.row

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
    last_error: hooks.error,
  })
}

/**
 * Ask Postmark to re-check DKIM + Return-Path, read the result, persist it,
 * and flip status → 'live' when both verify. IDEMPOTENT — re-running once
 * live keeps it live.
 *
 * @returns {Promise<{ row?: object, notProvisioned?: boolean, readFailed?: boolean, error?: string }>}
 */
export async function verifyEmailDomain(db, orgId) {
  let row
  try {
    row = await loadEmailDomainRow(db, orgId)
  } catch (e) {
    return { readFailed: true, error: e.message }
  }
  if (!row?.postmark_domain_id) return { notProvisioned: true }

  // W1.E3 — the verify button is the retry an operator can reach once the
  // domain exists (the wizard never POSTs the initiate route again), so a
  // NULL webhooks stamp is retried here too. Never fatal.
  const hooks = await ensureServerWebhooksRecorded(db, orgId, row)
  row = hooks.row

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
  return { row: await persistDomainState(db, orgId, row, shaped, hooks.error) }
}
