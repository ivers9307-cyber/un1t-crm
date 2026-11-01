// MCP.1 — the MCP server behind /api/mcp, and its RFC 9728 metadata.
//
// `buildMcpServer` is the initialiser mcp-handler calls for every request
// (serving is stateless): it registers each tool in TOOLS, and each call runs
// through `runTool`, which re-checks the caller's role, studio and the
// organisation's MCP switch. The caller is the AuthInfo `verifyMcpToken`
// returned to `withMcpAuth`; MCP SDK v2 hands it to a tool callback as
// `ctx.http.authInfo` (v1's `extra.authInfo`).
//
// There is ONE canonical MCP URL in v1: `${getAppUrl()}/api/mcp`. RFC 9728
// needs the metadata's `resource` to equal the URL the client connected
// with, so the route answers 404 on every other host (`isCanonicalHost`) and
// the metadata names that URL explicitly rather than deriving it from the
// request: both well-known paths, on any host, serve the same document.

import { createMcpHandler, withMcpAuth, protectedResourceHandler, metadataCorsOptionsRequestHandler } from 'mcp-handler'
import { TOOLS } from '@/lib/agent-tools'
import { runTool, toolResult } from '@/lib/agent-tools/registry'
import { getAppUrl } from '@/lib/app-url'
import { connectorUrl } from '@/lib/mcp/connector-url'
import { createServerClient } from '@/lib/supabase'

const UNAUTHENTICATED = {
  ok: false,
  code: 'unauthenticated',
  message: 'This connection is not signed in. Reconnect the MCP server and try again.',
}

/**
 * Register every agent tool on an MCP server.
 *
 * @param {{ registerTool: Function }} server an McpServer (SDK v2)
 */
export function buildMcpServer(server) {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args, ctx) => {
        const authInfo = ctx?.http?.authInfo
        // withMcpAuth({ required: true }) answers 401 before a tool can run, so
        // this is a second fence, not a path: never run a tool for nobody.
        if (!authInfo?.extra?.user) return toolResult(UNAUTHENTICATED)
        return toolResult(await runTool(tool, args, authInfo, { db: createServerClient() }))
      },
    )
  }
}

/**
 * True when the request reached the canonical host (NEXT_PUBLIC_APP_URL's).
 * Throws when NEXT_PUBLIC_APP_URL is unset (no silent fallback).
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isCanonicalHost(request) {
  return new URL(request.url).host === new URL(getAppUrl()).host
}

/**
 * The MCP handler behind its auth gate: the route's only door, so the route
 * and the test that pins the 401 challenge share these exact options.
 * Calls getAppUrl() (throws when NEXT_PUBLIC_APP_URL is unset), so build it
 * per request or lazily, never at import.
 *
 * @param {(req: Request, token?: string) => Promise<object | null | undefined>} verify
 * @returns {(req: Request) => Promise<Response>}
 */
export function buildAuthedHandler(verify) {
  return withMcpAuth(
    createMcpHandler(buildMcpServer, { serverInfo: { name: 'repset-crm', version: '1' } }),
    verify,
    {
      required: true,
      resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
      // The challenge names the canonical metadata URL, whatever proxy
      // headers the request carried.
      resourceUrl: new URL(getAppUrl()).origin,
    },
  )
}

/** The one MCP resource URL. */
export function mcpResourceUrl() {
  return connectorUrl()
}

function supabaseAuthServerUrl() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set: the MCP metadata cannot name its authorization server.')
  return `${base.replace(/\/+$/, '')}/auth/v1`
}

/** GET for both `/.well-known/oauth-protected-resource` paths. */
export function protectedResourceGET(request) {
  return protectedResourceHandler({
    authServerUrls: [supabaseAuthServerUrl()],
    resourceUrl: mcpResourceUrl(),
  })(request)
}

/** OPTIONS (CORS preflight) for both well-known paths. */
export const protectedResourceOPTIONS = metadataCorsOptionsRequestHandler()
