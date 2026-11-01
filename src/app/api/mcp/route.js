// MCP.1 — the staff MCP endpoint (Streamable HTTP, stateless, mcp-handler 2).
//
// Public in src/proxy.js (exact match), so this route authenticates itself:
// withMcpAuth → verifyMcpToken (src/lib/mcp/auth.js) turns the OAuth-issued
// Supabase JWT into the signed-in person, and a missing or bad token answers
// 401 with the RFC 9728 WWW-Authenticate challenge pointing at the metadata.
// Every tool then re-checks role, studio and the org switch in runTool.
//
// One canonical host in v1: any other host answers 404 before auth runs.

import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { verifyMcpToken } from '@/lib/mcp/auth'
import { buildMcpServer, isCanonicalHost } from '@/lib/mcp/server'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Built on the first canonical request, not at import: getAppUrl() throws
// when NEXT_PUBLIC_APP_URL is unset, and the module is imported at build.
let authedHandler = null
function mcpHandler() {
  authedHandler ??= withMcpAuth(
    createMcpHandler(buildMcpServer, { serverInfo: { name: 'repset-crm', version: '1' } }),
    (_req, token) => verifyMcpToken(token),
    {
      required: true,
      resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
      // The challenge names the canonical metadata URL, whatever proxy
      // headers the request carried.
      resourceUrl: new URL(getAppUrl()).origin,
    },
  )
  return authedHandler
}

async function handle(request) {
  if (!isCanonicalHost(request)) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  return mcpHandler()(request)
}

export { handle as GET, handle as POST, handle as DELETE }
