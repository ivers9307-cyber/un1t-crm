// MCP.1 — `whoami`: who the agent is acting as, at which studios, and what it
// may do. Always available (it is how a client learns that MCP is off for an
// organisation), open to anyone with a studio.
//
// Each studio echoes only id, name, zone, role, today's date there, whether
// MCP is on for its organisation and whether the person holds `assistant`
// there: never the location row itself (it carries settings).

import { z } from 'zod'
import { defineTool } from './registry.js'
import { resolveStudio, roleAt } from '@/lib/mcp/context'
import { hasPermissionForLocation } from '@/lib/permissions'
import { todayStrIn, zoneOfLocation } from '@/lib/location-time'

export default defineTool({
  name: 'whoami',
  title: 'Who am I',
  description: 'Who this connection acts as: the person, each of their studios (id, name, time zone, role there, '
    + 'today\'s date there, whether MCP is on for its organisation, whether the AI Assistant permission is held there), '
    + 'the default studio, and the tools that may be called at the studio this call resolved to (the default when '
    + 'studio_id is omitted). Call it first.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: () => true,
  alwaysAvailable: true,
  run: async (_input, ctx) => {
    const { user, studio, enabledOrgIds, nowMs } = ctx
    // Dynamic: index.js imports this module, so a static import would be a cycle.
    const { TOOLS } = await import('./index.js')
    const mcpOn = (s) => enabledOrgIds.includes(s.organization_id)

    const studios = (user.locations || []).map((l) => {
      const zone = zoneOfLocation(l)
      return {
        id: l.id,
        name: l.name,
        timezone: zone,
        role: roleAt(user, l.id),
        today: todayStrIn(zone, nowMs),
        mcp_enabled: mcpOn(l),
        assistant: hasPermissionForLocation(user, l.id, 'assistant'),
      }
    })

    const tools = TOOLS
      .filter((t) => (t.alwaysAvailable || mcpOn(studio)) && t.gate(user, studio.id, ctx))
      .map((t) => t.name)

    const fallback = resolveStudio(user, null)
    return {
      name: user.full_name ?? null,
      studios,
      tools,
      default_studio_id: fallback.ok ? fallback.studio.id : null,
    }
  },
})
