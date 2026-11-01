// MCP.1 — the agent tool registry. Every tool the staff MCP server exposes is
// a `defineTool({ … })` module in this directory, listed in index.js, and is
// only ever run through `runTool`, which applies the same checks in the same
// order for all of them:
//
//   rate limit (120/min per person, malformed calls included) → input (zod) → studio (resolveStudio:
//   one of the person's studios where they hold `assistant`) → the studio's
//   organisation has MCP switched on (unless the tool is `alwaysAvailable`)
//   → the tool's own gate → run.
//
// Every refusal is a tool-level result `{ ok: false, code, message }` (the
// client can explain it), never a throw, and every call, refused or not, ends
// in one `mcp_tool_calls` row (recordToolCall: no arguments, no result), except
// `rate_limited`, which the limiter itself bounds.
// tests/agent-tools-guard.test.js polices the tool files themselves.

import { z } from 'zod'
import { checkRateLimit } from '@/lib/rate-limit'
import { todayStrIn, zoneOfLocation } from '@/lib/location-time'
import { logError } from '@/lib/log'
import { resolveStudio, roleAt } from '@/lib/mcp/context'
import { recordToolCall } from '@/lib/mcp/log'

/**
 * Thrown by a tool's `gate` or `run` for an answer the client can act on (the
 * person is not at this studio, the target is deactivated): runTool turns it
 * into `{ ok: false, code, message }` and records that code. It is not logged
 * as an error. Codes a run may use: forbidden, not_found, invalid_input, conflict.
 * Any other throw is a failed call (`tool_failed`, logged).
 */
export class ToolRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolRefusal'
    this.code = code
  }
}

const RATE_LIMIT = Object.freeze({ max: 120, windowMs: 60_000 })

const MESSAGES = Object.freeze({
  studio_not_found: 'Unknown studio.',
  assistant_permission: 'The AI Assistant permission is not held at that studio.',
  assistant_permission_default: 'No studio where the AI Assistant permission is held.',
  studio_refused: 'That studio cannot be used.',
  mcp_disabled: 'MCP is not switched on for this organisation. Ask an organisation admin.',
  tool_failed: 'The tool failed. The error has been logged.',
})

/**
 * Declare a tool. The inputSchema must be a zod object carrying an optional
 * `studio_id` (every tool acts at one studio, the person's default when it is
 * omitted).
 *
 * @param {{ name: string, title: string, description: string, inputSchema: import('zod').ZodObject,
 *   gate: (user: object, studioId: string, ctx: object) => boolean,
 *   run: (input: object, ctx: object) => Promise<object>, writes?: boolean, alwaysAvailable?: boolean }} def
 */
export function defineTool({ name, title, description, inputSchema, gate, run, writes = false, alwaysAvailable = false }) {
  for (const [key, value] of Object.entries({ name, title, description })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`defineTool: ${key} is required`)
  }
  if (typeof gate !== 'function' || typeof run !== 'function') throw new TypeError(`defineTool(${name}): gate and run must be functions`)
  if (!inputSchema?.shape?.studio_id) throw new TypeError(`defineTool(${name}): inputSchema must include studio_id`)
  return Object.freeze({ name, title, description, inputSchema, gate, run, writes, alwaysAvailable })
}

function zodMessage(error) {
  const { formErrors, fieldErrors } = z.flattenError(error)
  return [
    ...formErrors,
    ...Object.entries(fieldErrors).map(([field, msgs]) => `${field}: ${msgs.join(', ')}`),
  ].join('; ') || 'Invalid input.'
}

function studioMessage(code, studioId) {
  if (code === 'assistant_permission' && !studioId) return MESSAGES.assistant_permission_default
  return MESSAGES[code] || MESSAGES.studio_refused
}

/**
 * Run one tool call for the person behind `auth` (verifyMcpToken's McpAuth).
 *
 * @param {object} tool a defineTool() result
 * @param {unknown} rawInput the client's arguments
 * @param {{ clientId: string, extra: { user: object, enabledOrgIds: string[] } }} auth
 * @param {{ db: object, nowMs?: number }} opts db is a service-role client
 * @returns {Promise<{ ok: true, data: object } | { ok: false, code: string, message: string }>}
 */
export async function runTool(tool, rawInput, auth, { db, nowMs = Date.now() } = {}) {
  const startedMs = Date.now()
  const user = auth.extra.user
  const enabledOrgIds = auth.extra.enabledOrgIds || []
  let studio = null

  let result
  try {
    result = await check()
  } catch (err) {
    if (err instanceof ToolRefusal) {
      result = { ok: false, code: err.code, message: err.message }
    } else {
      // Any other throw (run or gate) is a failed call, recorded like any other.
      logError('mcp', 'tool failed', { tool: tool.name, err })
      result = { ok: false, code: 'tool_failed', message: MESSAGES.tool_failed }
    }
  }

  async function check() {
    // Rate limit FIRST, so a malformed call is throttled like any other.
    const limit = await checkRateLimit(db, `mcp:${user.id}`, RATE_LIMIT)
    if (!limit.allowed) {
      return { ok: false, code: 'rate_limited', message: `Too many tool calls. Try again in ${limit.retryAfterSec} seconds.` }
    }

    const parsed = tool.inputSchema.safeParse(rawInput ?? {})
    if (!parsed.success) return { ok: false, code: 'invalid_input', message: zodMessage(parsed.error) }
    const input = parsed.data

    const resolved = resolveStudio(user, input.studio_id ?? null)
    if (!resolved.ok) return { ok: false, code: resolved.code, message: studioMessage(resolved.code, input.studio_id) }
    studio = resolved.studio

    if (!tool.alwaysAvailable && !enabledOrgIds.includes(studio.organization_id)) {
      return { ok: false, code: 'mcp_disabled', message: MESSAGES.mcp_disabled }
    }

    const zone = zoneOfLocation(studio)
    const ctx = {
      db, user, studio, zone, nowMs, enabledOrgIds,
      today: todayStrIn(zone, nowMs),
      role: roleAt(user, studio.id),
    }
    if (!tool.gate(user, studio.id, ctx)) {
      return { ok: false, code: 'forbidden', message: `The role held at ${studio.name} does not allow ${tool.title}.` }
    }

    return { ok: true, data: await tool.run(input, ctx) }
  }

  // A rate_limited refusal is not recorded: the limiter is the bound on how
  // fast a client can write rows, and recording refusals would hand an
  // authenticated client an unbounded insert.
  if (result.code === 'rate_limited') return result

  await recordToolCall(db, {
    profileId: user.id,
    organizationId: studio?.organization_id ?? null,
    locationId: studio?.id ?? null,
    clientId: auth.clientId,
    tool: tool.name,
    ok: result.ok,
    errorCode: result.ok ? null : result.code,
    durationMs: Date.now() - startedMs,
  })
  return result
}

/** A runTool result in the MCP `CallToolResult` shape. */
export function toolResult(result) {
  if (result.ok) return { content: [{ type: 'text', text: JSON.stringify(result.data ?? null) }] }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: result.code, message: result.message }) }],
  }
}
