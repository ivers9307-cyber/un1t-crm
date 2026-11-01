// MCP.1 — the organisation switch's reads, shared by GET /api/settings/org-mcp
// and the Integrations hub page so the card on first paint and the card after
// a save say the same thing.
//
// The switch lives on org_settings.mcp_enabled (mig 801). An organisation with
// no org_settings row yet has it OFF (maybeSingle: zero rows is the normal
// answer, not an error). "People who used it" is the count of DISTINCT
// profile_id in mcp_tool_calls for the organisation in the last 30 days.

import { connectorUrl } from '@/lib/mcp/connector-url'
import { selectAll } from '@/lib/select-all'
import { logError } from '@/lib/log'

export const MCP_PEOPLE_WINDOW_DAYS = 30

// The connector URL has one definition (connector-url.js); re-exported so the
// existing importers keep working.
export { connectorUrl }

/**
 * @param {object} db  service-role supabase client
 * @param {string} orgId
 * @param {number} [now]  epoch ms (tests)
 * @returns {Promise<{ mcp_enabled: boolean, people_30d: number }>}
 * @throws on either read failing: an unread switch must not render as "off".
 */
export async function loadOrgMcpState(db, orgId, now = Date.now()) {
  const cutoff = new Date(now - MCP_PEOPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  // Paged, not capped: one heavy user can make more than 1000 calls in 30 days,
  // and a truncated page would undercount the people behind them.
  const [settings, calls] = await Promise.all([
    db.from('org_settings').select('mcp_enabled').eq('organization_id', orgId).maybeSingle(),
    selectAll((from, to) => db.from('mcp_tool_calls')
      .select('profile_id')
      .eq('organization_id', orgId)
      .gte('created_at', cutoff)
      .order('id')
      .range(from, to))
      .then((data) => ({ data, error: null }), (error) => ({ data: null, error })),
  ])
  if (settings.error) throw settings.error
  if (calls.error) throw calls.error
  const people = new Set((calls.data || []).map((r) => r.profile_id).filter(Boolean))
  return { mcp_enabled: settings.data?.mcp_enabled === true, people_30d: people.size }
}

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
