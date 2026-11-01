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

import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermissionAtAnyLocation } from '@/lib/permissions'
import { jwtClientId } from '@/lib/oauth-token-edge'
import { logError } from '@/lib/log'
import { mcpEnabledOrgIds } from '@/lib/mcp/org-switch'

// The switch read lives in org-switch.js: this file names the anon key (the token check),
// so tests/org-settings-client-closed-guard.test.js would read an org_settings read here as
// browser code. Re-exported for the consent page and the tests.
export { mcpEnabledOrgIds }

/**
 * Ask Supabase Auth who this exact token belongs to. getCurrentUser() takes
 * no token: it reads the request itself and, when the Bearer fails, falls
 * back to the SSR cookie session and the studio PIN cookie. So the token has
 * to be verified here, on its own, and the result bound to what
 * getCurrentUser() resolved.
 *
 * @param {string} token
 * @returns {Promise<{ id: string } | null>} null for a bad token or an
 *   unreachable Supabase (logged once for the latter)
 */
export async function defaultVerifyToken(token) {
  try {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { data } = await client.auth.getUser(token)
    return data?.user ?? null
  } catch (err) {
    logError('mcp', 'token did not verify', { code: err?.code })
    return null
  }
}

/**
 * Order: client_id claim -> verify the token with Supabase Auth -> resolve
 * the person with getCurrentUser() -> require both to be the same person and
 * not a master "View as" session (impersonation is forbidden on this path).
 *
 * @param {string} token the raw Bearer token
 * @param {{ getUser?: Function, verifyToken?: Function, db?: object }} [opts] injected in tests
 * @returns {Promise<null | { token: string, clientId: string, scopes: string[],
 *   extra: { user: object, enabledOrgIds: string[], assistantAnywhere: boolean } }>}
 */
export async function verifyMcpToken(token, { getUser = getCurrentUser, verifyToken = defaultVerifyToken, db } = {}) {
  const clientId = jwtClientId(token)
  if (!clientId) return null

  const authUser = await verifyToken(token)
  if (!authUser) return null

  let user
  try {
    user = await getUser()
  } catch (err) {
    logError('mcp', 'token verification failed', { code: err?.code })
    return null
  }
  if (!user) return null

  if (authUser.id !== user.id || user.impersonatingFrom) {
    logError('mcp', 'token not bound to the resolved session')
    return null
  }

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
