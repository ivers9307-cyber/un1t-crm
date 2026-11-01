// MCP.1 — the ONE definition of the connector URL staff paste into Claude (and
// the MCP resource URL the OAuth metadata names). Dependency-free beyond
// app-url so server.js and org-switch.js can both import it with no cycle.

import { getAppUrl } from '@/lib/app-url'

export function connectorUrl() {
  return `${getAppUrl()}/api/mcp`
}
