// ASSISTREG.2 — the in-app assistant runs the SAME tool bodies as the staff
// MCP server (`src/lib/agent-tools/`), through its own door.
//
// Two doors, one set of tools. What each door owns:
//
//   MCP (`runTool`)        rate limit, a studio the person holds `mcp_access`
//                          at, the `org_settings.mcp_enabled` switch, and one
//                          `mcp_tool_calls` row per call.
//   assistant (this file)  the web session, and the studio is ALWAYS
//                          `user.activeLocation` — the model never names one.
//
// Both then go through `runToolAtStudio`, so the tool's own gate and body are
// identical whoever asked. Nothing here writes `mcp_tool_calls`: those rows
// are the only signal for whether anything has ever connected over MCP, and
// assistant traffic in them would destroy it.
//
// The gates are now the registry's, which is a DELIBERATE tightening over the
// flat role tiers this replaced (Richard's call, 11 Nov 2026). The old
// `TOOL_PERMISSIONS` map judged role alone, so a manager or head coach could
// search contacts through the assistant without holding **Contacts**, create
// an activity without **Activities**, and so on — the permission the same
// person needs for the equivalent screen. Those keys now bind here too.

import { z } from 'zod'
import { TOOLS } from '@/lib/agent-tools'
import { parseToolInput, runToolAtStudio } from '@/lib/agent-tools/registry'
import { assistantReadableStudioIds } from '@/lib/agent-tools/_contact-scope'
import { roleAt } from '@/lib/mcp/context'
import { ADMIN_ROLES, MANAGER_ROLES } from '@/lib/schemas'

/**
 * The tools the assistant runs from the registry, by name. Everything else the
 * assistant offers (`navigate_user`, `generate_report`) has no registry twin
 * and stays local to the chat route.
 *
 * `get_shifts` replaces the old `get_shifts_for_week`. That tool took one date
 * and snapped it to the Monday of its week because a single date is ambiguous
 * (SCHEDHYGIENE.1); `get_shifts` takes an explicit start and end, so there is
 * nothing to disambiguate. The safety half of SCHEDHYGIENE.1 is unchanged and
 * lives in the registry tool: non-managers see published rosters only, and
 * `unpublished_days` names the days no published roster covers, so a half
 * published week reads as "not published yet" and never as "nobody working".
 */
export const BRIDGED_TOOL_NAMES = Object.freeze([
  'search_contacts',
  'create_contact',
  'create_activity',
  'create_shift',
  'list_staff',
  'list_shift_templates',
  'get_shifts',
  'get_time_off',
  'get_holiday_allowance',
])

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * ASSISTREG.3 — the assistant's historical role tier for each bridged tool,
 * kept as a FLOOR under the registry's gate. Effective access is the
 * INTERSECTION, so moving onto the registry gates can only ever narrow what
 * the assistant grants, never widen it.
 *
 * Without this floor the swap silently WIDENED one tool: `contacts` defaults
 * to true for every role including staff, and the registry gates
 * search_contacts on that key with no role floor, where the assistant has
 * always demanded the manager tier. The MCP server keeps the unfloored gate
 * (a staff member holding Connect an Agent and Contacts may search there) —
 * which is why the floor lives in THIS door and not in the tool.
 *
 * 'all' = any role · 'manager' = owner/manager/head_coach (+ master)
 * 'admin' = owner/manager (+ master)
 */
const TIER_FLOOR = Object.freeze({
  search_contacts: 'manager',
  create_contact: 'admin',
  create_activity: 'manager',
  create_shift: 'manager',
  list_staff: 'manager',
  list_shift_templates: 'manager',
  // get_shifts replaces get_shifts_for_week, which was 'all'.
  get_shifts: 'all',
  get_time_off: 'all',
  get_holiday_allowance: 'all',
})

/** Whether the person clears the assistant's own historical tier at a studio. */
function clearsTierFloor(name, user, studioId) {
  const tier = TIER_FLOOR[name]
  if (tier === 'all') return true
  const role = roleAt(user, studioId)
  if (tier === 'manager') return MANAGER_ROLES.includes(role)
  if (tier === 'admin') return ADMIN_ROLES.includes(role)
  // An unlisted bridged tool fails closed rather than inheriting 'all'.
  return false
}

/** @returns {boolean} whether this tool name is run from the registry. */
export function isBridgedTool(name) {
  return BRIDGED_TOOL_NAMES.includes(name)
}

/** The registry definition behind a bridged name (undefined otherwise). */
export function bridgedTool(name) {
  return isBridgedTool(name) ? BY_NAME.get(name) : undefined
}

/**
 * The JSON Schema the assistant advertises to Anthropic for a bridged tool:
 * the registry tool's own schema with `studio_id` removed.
 *
 * Removed at the JSON-Schema level, not with zod's `.omit()`: `.omit()` throws
 * on an object carrying refinements ("cannot be used on object schemas
 * containing refinements"), which `get_shifts` and the reports all do, and
 * dropping the refinement would lose the range check anyway. Parsing still
 * uses the FULL schema, so every refinement runs.
 *
 * Why remove it at all: the studio is the session's active location. Leaving
 * `studio_id` in the schema would invite the model — or anything that can
 * steer the model, such as text in a contact note it has just read — to name
 * another studio. `runAssistantTool` also strips it from the input, so a
 * hallucinated one can never reach a tool body.
 */
export function assistantToolSchema(name) {
  const tool = bridgedTool(name)
  if (!tool) throw new Error(`assistantToolSchema: ${name} is not a bridged tool`)
  const schema = z.toJSONSchema(tool.inputSchema)
  delete schema.$schema
  if (schema.properties) delete schema.properties.studio_id
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((k) => k !== 'studio_id')
    if (schema.required.length === 0) delete schema.required
  }
  return schema
}

/** Anthropic tool definitions for every bridged tool, in registry order. */
export function bridgedToolDefinitions() {
  return BRIDGED_TOOL_NAMES.map((name) => {
    const tool = bridgedTool(name)
    return { name: tool.name, description: tool.description, input_schema: assistantToolSchema(name) }
  })
}

/**
 * The bridged tools this person may actually use at their active location, as
 * Anthropic definitions. The gate runs again at call time in
 * `runToolAtStudio`; this only keeps the model from being offered a tool it
 * would be refused.
 *
 * A bridged tool's gate must be answerable from `(user, studioId)` alone —
 * every one of them is. `get_contact`'s gate reads a third `ctx` argument, so
 * it is deliberately NOT bridged; bridging it would need a context here, and
 * advertising tools must not touch the database.
 */
export function allowedBridgedToolDefinitions(user) {
  const studioId = user?.activeLocation?.id
  if (!studioId) return []
  return bridgedToolDefinitions().filter((def) => {
    const tool = bridgedTool(def.name)
    try {
      return clearsTierFloor(def.name, user, studioId) && Boolean(tool.gate(user, studioId, {
        readableStudioIds: assistantReadableStudioIds(user, studioId),
      }))
    } catch {
      // A gate that cannot answer is not an invitation.
      return false
    }
  })
}

/**
 * Run a bridged tool for the in-app assistant and answer in the shape the chat
 * route's tool loop already speaks: the tool's data on success, `{ error }` on
 * any refusal, so the model can explain itself and ask again.
 *
 * @param {string} name a BRIDGED_TOOL_NAMES entry
 * @param {object} rawInput the model's arguments
 * @param {{ db: object, user: object, nowMs?: number }} ctx
 *   `user` is the getCurrentUser() session — the same shape the MCP door
 *   passes, which is what makes one body serve both.
 */
export async function runAssistantTool(name, rawInput, { db, user, nowMs = Date.now() }) {
  const tool = bridgedTool(name)
  if (!tool) return { error: `Unknown tool: ${name}` }

  const studio = user?.activeLocation
  if (!studio?.id) {
    return { error: 'No active location — switch to a location before using this.' }
  }

  // The studio is the session's, never the model's. Strip any studio_id it
  // sent so no tool body can read one (runToolAtStudio ignores it regardless).
  const { studio_id: _ignored, ...input } = rawInput && typeof rawInput === 'object' ? rawInput : {}

  // The assistant's own historical tier, under the tool's gate: the swap can
  // narrow access, never widen it (TIER_FLOOR).
  if (!clearsTierFloor(name, user, studio.id)) {
    return { error: `Permission denied: your role does not have access to this action. Please ask a manager or owner for help.` }
  }

  const parsed = parseToolInput(tool, input)
  if (!parsed.ok) return { error: parsed.message }

  const result = await runToolAtStudio(tool, parsed.input, {
    db, user, studio, nowMs,
    // ASSISTREG.3 — this door's contact reach: the active studio on Contacts
    // alone. Never mcp_access, never the MCP org switch.
    readableStudioIds: assistantReadableStudioIds(user, studio.id),
  })
  return result.ok ? result.data : { error: result.message }
}
