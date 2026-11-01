// MCP.1 — the staff MCP endpoint (Streamable HTTP, stateless, mcp-handler 2).
//
// Public in src/proxy.js (exact match), so this route authenticates itself:
// withMcpAuth → verifyMcpToken (src/lib/mcp/auth.js) turns the OAuth-issued
// Supabase JWT into the signed-in person, and a missing or bad token answers
// 401 with the RFC 9728 WWW-Authenticate challenge pointing at the metadata
// (buildAuthedHandler in src/lib/mcp/server.js holds the options). Every tool
// then re-checks role, studio and the org switch in runTool.
//
// One canonical host in v1: any other host answers 404 before auth runs.

import { verifyMcpToken } from '@/lib/mcp/auth'
import { buildAuthedHandler, isCanonicalHost } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Built on the first canonical request, not at import: getAppUrl() throws
// when NEXT_PUBLIC_APP_URL is unset, and the module is imported at build.
let authedHandler = null

async function handle(request) {
  if (!isCanonicalHost(request)) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  authedHandler ??= buildAuthedHandler((_req, token) => verifyMcpToken(token))
  return authedHandler(request)
}

export { handle as GET, handle as POST, handle as DELETE }
