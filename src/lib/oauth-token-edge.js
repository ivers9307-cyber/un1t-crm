// MCP.1 — Edge-runtime-safe peek at an OAuth-issued token.
//
// The staff MCP server (/api/mcp) authenticates with a Supabase OAuth-server
// access token. Unlike a session JWT, that token's payload carries a
// `client_id` claim naming the OAuth client it was issued to. src/proxy.js
// runs on the Edge runtime (no `node:` imports), so this decodes the payload
// with atob and NEVER verifies the signature: the proxy uses the answer only
// to REFUSE such a token on every /api route but /api/mcp. The route itself
// verifies the token properly. A forged `client_id` can therefore only make
// the proxy stricter, never let anything in.

/**
 * @param {string} token a Bearer token
 * @returns {string | null} the payload's `client_id` when it is a non-empty
 *   string, else null. Malformed input is null, never a throw.
 */
export function jwtClientId(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    b64 += '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(b64))
    const id = payload && typeof payload === 'object' ? payload.client_id : null
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}
