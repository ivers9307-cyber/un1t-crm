// MCP.1 — the only writer of `mcp_tool_calls` (mig 801), the audit trail of
// what an AI agent did through /api/mcp. Deliberately records WHO, WHERE,
// WHICH tool and HOW IT WENT, never the arguments: those carry member names,
// emails and message text, and this table is read by operators.

import { logError } from '@/lib/log'

/**
 * Record one tool call. Never throws: a lost log row must not fail the tool
 * call it describes (the failure is logged instead).
 *
 * @param {object} db a service-role supabase client
 * @param {{ profileId: string, organizationId: string | null, locationId: string | null,
 *   clientId: string, tool: string, ok: boolean, errorCode?: string | null, durationMs: number }} call
 * @returns {Promise<void>}
 */
export async function recordToolCall(db, { profileId, organizationId, locationId, clientId, tool, ok, errorCode = null, durationMs }) {
  try {
    const { error } = await db.from('mcp_tool_calls').insert({
      profile_id: profileId,
      organization_id: organizationId,
      location_id: locationId,
      client_id: clientId,
      tool,
      ok,
      error_code: errorCode,
      duration_ms: durationMs,
    })
    if (error) logError('mcp', 'tool call not recorded', { tool, code: error.code })
  } catch (err) {
    logError('mcp', 'tool call not recorded', { tool, code: err?.code })
  }
}
