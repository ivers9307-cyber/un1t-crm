// MCP.1 — RFC 9728 protected-resource metadata for /api/mcp (path-suffixed
// form, the one withMcpAuth's 401 challenge names). Same document as
// ../../route.js (src/lib/mcp/server.js). Public by definition, no data.

import { protectedResourceGET, protectedResourceOPTIONS } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export { protectedResourceGET as GET, protectedResourceOPTIONS as OPTIONS }
