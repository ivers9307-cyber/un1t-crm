// MCP.1 — RFC 9728 protected-resource metadata for /api/mcp (root form).
// Clients derive the metadata path from the resource URL in different ways,
// so this and ./api/mcp/route.js serve the same document
// (src/lib/mcp/server.js). Public by definition, no data.

import { protectedResourceGET, protectedResourceOPTIONS } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export { protectedResourceGET as GET, protectedResourceOPTIONS as OPTIONS }
