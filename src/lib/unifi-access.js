// UniFi Access (Developer API v1) — minimal client.
//
// We only ever need four operations to drive the "door access" toggle on
// staff profiles:
//
//   1. Find a UniFi user by email                  → /users/search
//   2. Create a UniFi user                          → POST /users
//   3. Replace the policies assigned to a user      → PUT /users/:id/access_policies
//   4. Read the controller's existing policies      → GET /access_policies (sanity / admin)
//
// All other resources (Door Groups, Schedules, Holiday Groups) live
// entirely in UniFi — managers configure those once per studio in the
// UniFi console and we just reference the resulting access-policy IDs.
//
// API base: https://<host>:12445/api/v1/developer
//   - Bearer token auth, scopes: view:user, edit:user, view:policy.
//   - Self-signed cert by default; the controller can be put behind a
//     real cert via Cloudflare Tunnel etc., in which case the
//     allow_self_signed flag stays off.
//
// References:
//   docs §3.24 Search Users, §3.2 User Registration,
//   §3.6 Assign Access Policy to User, §5.6 Fetch All Access Policies.

import { Agent, fetch as undiciFetch } from 'undici'

const DEFAULT_TIMEOUT_MS = 10_000

// Cached dispatcher for studios that opted in to "ignore self-signed cert".
// One per process is fine — undici Agent is reusable & connection-pooled.
let insecureDispatcher = null
function getInsecureDispatcher() {
  if (!insecureDispatcher) {
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  }
  return insecureDispatcher
}

/**
 * Pull the per-location UniFi config out of locations.settings.unifi.
 * Returns { configured, host, apiToken, staffPolicyId, managerPolicyId,
 *           allowSelfSigned }.
 *
 * configured = true only when host + apiToken + both policy IDs are set.
 * Anything less and the toggle should refuse to flip on (we surface a
 * clear "configure UniFi for this location first" error).
 */
export function getLocationUnifiConfig(location) {
  const u = location?.settings?.unifi || {}
  const host = (u.host || '').trim().replace(/\/+$/, '')   // strip trailing slash
  const apiToken = (u.api_token || '').trim()
  const staffPolicyId = (u.staff_policy_id || '').trim()
  const managerPolicyId = (u.manager_policy_id || '').trim()
  return {
    configured: Boolean(host && apiToken && staffPolicyId && managerPolicyId),
    host, apiToken, staffPolicyId, managerPolicyId,
    allowSelfSigned: u.allow_self_signed === true,
  }
}

/**
 * Map a CRM role to the UniFi access-policy ID for that role at a given
 * location. Master/Owner/Manager get full-access (manager_policy_id),
 * everyone else gets the staff policy. Mirrors MANAGER_ROLES in
 * src/lib/schemas.js (master added in mig 033).
 */
export function policyIdForRole(cfg, role) {
  if (!cfg?.configured) return null
  return role === 'master' || role === 'owner' || role === 'manager'
    ? cfg.managerPolicyId
    : cfg.staffPolicyId
}

// ---- low-level HTTP --------------------------------------------------------

class UnifiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'UnifiError'
    this.status = status
    this.code = code
  }
}

/**
 * Generic call against the UniFi Developer API. All public functions go
 * through here so retry / logging / error shaping happens in one place.
 */
async function call(cfg, method, path, body) {
  if (!cfg?.host) throw new UnifiError('UniFi host not configured')
  if (!cfg?.apiToken) throw new UnifiError('UniFi API token not configured')

  const url = `${cfg.host}/api/v1/developer${path}`
  const headers = {
    Authorization: `Bearer ${cfg.apiToken}`,
    'Accept': 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const init = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  }
  if (cfg.allowSelfSigned) init.dispatcher = getInsecureDispatcher()

  let res
  try {
    res = await undiciFetch(url, init)
  } catch (e) {
    // Network-level failure — controller offline, DNS broken, tunnel down.
    throw new UnifiError(`UniFi request failed: ${e.message || e}`, {})
  }

  let payload = null
  try { payload = await res.json() } catch { /* non-JSON, leave null */ }

  if (!res.ok || (payload && payload.code && payload.code !== 'SUCCESS')) {
    const code = payload?.code || `HTTP_${res.status}`
    const msg = payload?.msg || res.statusText || 'Unknown UniFi error'
    throw new UnifiError(`${code}: ${msg}`, { status: res.status, code })
  }
  return payload?.data ?? null
}

// ---- public operations -----------------------------------------------------

/**
 * Search for a user by email. Returns the first matching user or null.
 *
 * Wraps §3.24 POST /users/search with a phrase-match on user_email. The
 * controller can return multiple users (different first names, same
 * email is normally rejected by UniFi but happened to one staffer once,
 * so we tolerate it and pick the first).
 */
export async function findUnifiUserByEmail(cfg, email) {
  if (!email) return null
  const data = await call(cfg, 'POST', '/users/search', {
    keyword: email,
    page_num: 1,
    page_size: 25,
  })
  // Response shape: { users: [...], pagination: {...} } per docs §3.24.
  const users = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : []
  const exact = users.find(u =>
    (u.user_email || '').toLowerCase() === email.toLowerCase()
  )
  return exact || null
}

/**
 * Register a new UniFi user. Returns the created user (with id).
 * Per §3.2 the only required fields are first_name + last_name.
 */
export async function createUnifiUser(cfg, { firstName, lastName, email, employeeNumber }) {
  if (!firstName || !lastName) {
    throw new UnifiError('firstName and lastName are required to create a UniFi user')
  }
  return await call(cfg, 'POST', '/users', {
    first_name: firstName,
    last_name: lastName,
    user_email: email || undefined,
    employee_number: employeeNumber || undefined,
  })
}

/**
 * Find a UniFi user by email; if none exists, create one. Returns the
 * UniFi user id (string).
 *
 * Idempotent — calling this twice with the same profile returns the same
 * id without creating duplicates.
 */
export async function findOrCreateUnifiUser(cfg, profile) {
  const email = profile.email || profile.user_email
  if (email) {
    const existing = await findUnifiUserByEmail(cfg, email)
    if (existing?.id) return existing.id
  }
  // Best-effort name split. UniFi requires both halves; if only one was
  // provided, duplicate it rather than rejecting the toggle entirely.
  const fullName = (profile.full_name || '').trim()
  const parts = fullName.split(/\s+/)
  const firstName = parts[0] || 'Staff'
  const lastName = parts.slice(1).join(' ') || parts[0] || 'Member'
  const created = await createUnifiUser(cfg, {
    firstName,
    lastName,
    email,
    employeeNumber: profile.id,   // CRM profile UUID — handy for support lookups
  })
  if (!created?.id) {
    throw new UnifiError('UniFi did not return an id for the newly created user')
  }
  return created.id
}

/**
 * Replace the access policies assigned to a UniFi user. Pass an empty
 * array to revoke all policies (effectively removing door access).
 * Per §3.6 PUT /users/:id/access_policies.
 */
export async function setUnifiUserPolicies(cfg, unifiUserId, policyIds) {
  if (!unifiUserId) throw new UnifiError('unifiUserId is required')
  await call(cfg, 'PUT', `/users/${encodeURIComponent(unifiUserId)}/access_policies`, {
    access_policy_ids: Array.isArray(policyIds) ? policyIds : [policyIds].filter(Boolean),
  })
}

/**
 * Convenience: assign exactly the policy that matches the profile's role.
 * Returns the policy id that was assigned (caller can persist for audit).
 */
export async function syncUnifiUserPolicyForRole(cfg, unifiUserId, role) {
  const policyId = policyIdForRole(cfg, role)
  if (!policyId) {
    throw new UnifiError(
      `No UniFi policy configured for role "${role}" — set staff_policy_id ` +
      `and manager_policy_id on the location before enabling door access.`
    )
  }
  await setUnifiUserPolicies(cfg, unifiUserId, [policyId])
  return policyId
}

/**
 * Convenience: clear all access policies (used on toggle-off and on
 * staff deactivation). Idempotent — safe to call when no policies are
 * currently assigned.
 */
export async function revokeUnifiUserPolicies(cfg, unifiUserId) {
  await setUnifiUserPolicies(cfg, unifiUserId, [])
}

// ── Mig 093 / studio_management — list + remote-unlock doors ─────
//
// Two new operations on top of the four user-policy ones above:
//
//   listDoors(cfg)         GET    /doors
//   remoteUnlockDoor(cfg, doorId, { actorEmail }?)
//                          POST   /doors/{id}/remote_unlock
//
// `remote_unlock` triggers a one-shot unlock (the relay opens for the
// door's configured unlock duration in UniFi, then re-locks). That's
// the right shape for the operator-pressed-a-button-once flow — we
// don't need a temporary lock-rule.
//
// The actorEmail is optional but recommended: UniFi logs the API
// token name as the actor by default (e.g. "UN1T CRM (Stillorgan)"),
// which is fine for "who triggered" but not "which user pressed
// the button". We pass actorEmail through to a header so audit
// downstream can correlate. UniFi ignores unknown headers so this
// is forward-safe even if their schema changes.
//
// Both helpers throw UnifiError on failure so the route can return
// a clean message to the operator.

/**
 * List every door registered with the controller. Used to populate
 * the /studio-management page's per-door unlock buttons.
 *
 * Response shape from UniFi varies slightly by firmware — sometimes
 * it's `{ data: [doors] }`, sometimes `{ data: { doors: [...] } }`.
 * Tolerate both.
 */
export async function listDoors(cfg) {
  const data = await call(cfg, 'GET', '/doors')
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.doors)) return data.doors
  return []
}

/**
 * Trigger a one-shot remote unlock on a single door.
 *
 * @param {object} cfg          getLocationUnifiConfig() output
 * @param {string} doorId       UniFi door UUID
 * @param {object} [meta]       optional context for logging
 * @param {string} [meta.actorEmail]  CRM user who pressed the button
 */
export async function remoteUnlockDoor(cfg, doorId, meta = {}) {
  if (!doorId) throw new UnifiError('doorId is required')
  // Per UniFi Developer API §4 (Doors), the unlock endpoint takes
  // no body — the door's configured unlock duration drives how long
  // the relay stays open. We POST with a minimal stamp so audit
  // logs (theirs and ours) show who triggered it.
  return await call(cfg, 'POST', `/doors/${encodeURIComponent(doorId)}/remote_unlock`, {
    actor_email: meta.actorEmail || undefined,
  })
}

export { UnifiError }
