// MCP.1 — the identity layer of the staff MCP server.
//
// `verifyMcpToken` is what the /api/mcp route hands to mcp-handler's
// `withMcpAuth` as `(req, token) => verifyMcpToken(token)`. The token is a
// Supabase OAuth-server access token, which is an ordinary Supabase session
// JWT plus a `client_id` claim. `getCurrentUser()` already knows how to turn
// a Bearer JWT into the signed-in person (and refuses an inactive or
// tombstoned profile), so this module reuses it instead of re-implementing
// the profile read.
//
// Two acceptances, both deliberate and written down in the MCP.1 design:
//
// 1. REACH. Because the token is a normal session JWT, outside this app it
//    can reach whatever that person's phone session can (the RLS-bound
//    tables the phone reads directly). We document that and do not fence it
//    further in v1; src/proxy.js already refuses it on every /api route but
//    /api/mcp.
// 2. AUDIENCE. Supabase tokens carry `aud: authenticated`, so there is no
//    audience to check. The `client_id` claim stands in for audience
//    validation: a token minted for some OTHER MCP server on this Supabase
//    project would pass here. There is no other such server today. That is a
//    conscious acceptance, not an oversight.
//
// The door refuses only a bad or expired token (null). Policy refusals (the
// org's switch is off, no `assistant` permission, a role gate) are tool-level
// results made by the registry, which is why this returns the user plus
// `enabledOrgIds` and `assistantAnywhere` rather than refusing on them.

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermissionAtAnyLocation } from '@/lib/permissions'
import { jwtClientId } from '@/lib/oauth-token-edge'
import { logError } from '@/lib/log'

/**
 * The organisations (of this person's studios, plus those they administer)
 * whose `org_settings.mcp_enabled` switch is on. Also read by the consent
 * page. A failed read answers [] (fail closed) and is logged: an unreadable
 * switch must never read as "on".
 *
 * @param {object} db a service-role supabase client
 * @param {{ locations?: Array<{ organization_id?: string }>, orgAdminOrgIds?: string[] }} user
 * @returns {Promise<string[]>}
 */
export async function mcpEnabledOrgIds(db, user) {
  const orgIds = Array.from(new Set([
    ...(user?.locations || []).map((l) => l?.organization_id),
    ...(user?.orgAdminOrgIds || []),
  ].filter(Boolean)))
  if (orgIds.length === 0) return []

  const { data, error } = await db
    .from('org_settings')
    .select('organization_id')
    .eq('mcp_enabled', true)
    .in('organization_id', orgIds)
  if (error) {
    logError('mcp', 'org switch not readable', { code: error.code })
    return []
  }
  return (data || []).map((r) => r.organization_id)
}

/**
 * @param {string} token the raw Bearer token
 * @param {{ getUser?: Function, db?: object }} [opts] injected in tests
 * @returns {Promise<null | { token: string, clientId: string, scopes: string[],
 *   extra: { user: object, enabledOrgIds: string[], assistantAnywhere: boolean } }>}
 */
export async function verifyMcpToken(token, { getUser = getCurrentUser, db } = {}) {
  const clientId = jwtClientId(token)
  if (!clientId) return null

  let user
  try {
    user = await getUser()
  } catch (err) {
    logError('mcp', 'token verification failed', { code: err?.code })
    return null
  }
  if (!user) return null

  const enabledOrgIds = await mcpEnabledOrgIds(db || createServerClient(), user)
  return {
    token,
    clientId,
    scopes: [],
    extra: {
      user,
      enabledOrgIds,
      assistantAnywhere: hasPermissionAtAnyLocation(user, 'assistant'),
    },
  }
}
