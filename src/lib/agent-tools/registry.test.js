import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError } from '@/lib/log'
import { defineTool, runTool, toolResult, ToolRefusal } from './registry.js'
import { isManagerAt } from '@/lib/mcp/context'

const A = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const B = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ORG1 = 'org-1'
const ORG2 = 'org-2'

// A manager at studio A (org 1, MCP on) who is staff at studio B (org 2, MCP
// off). Staff does not hold `assistant` by default, so B carries a per-user
// override: the org switch, not the permission, is what refuses there.
function fakeAuth({ enabledOrgIds = [ORG1] } = {}) {
  const locations = [
    { id: A, name: 'Studio A', timezone: 'Europe/Dublin', organization_id: ORG1 },
    { id: B, name: 'Studio B', timezone: 'Europe/Dublin', organization_id: ORG2 },
  ]
  return {
    token: 't',
    clientId: 'client-1',
    scopes: [],
    extra: {
      user: {
        id: 'user-1',
        full_name: 'Pat Manager',
        role: 'manager',
        isMaster: false,
        locations,
        activeLocation: locations[0],
        rolesByLocation: { [A]: 'manager', [B]: 'staff' },
        assignmentsByLocation: {
          [A]: { role: 'manager', permissions: {} },
          [B]: { role: 'staff', permissions: { assistant: true } },
        },
      },
      enabledOrgIds,
      assistantAnywhere: true,
    },
  }
}

function fakeDb({ rateCount = 1 } = {}) {
  const inserts = []
  const db = {
    rpc: vi.fn(async () => ({ data: rateCount, error: null })),
    from: vi.fn((table) => ({
      insert: vi.fn(async (row) => { inserts.push({ table, row }); return { error: null } }),
    })),
  }
  return { db, inserts }
}

const echoRun = vi.fn(async (input) => ({ text: input.text }))
const echo = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Says the text back.',
  inputSchema: z.object({ studio_id: z.string().uuid().optional(), text: z.string() }),
  gate: (u, s) => isManagerAt(u, s),
  run: echoRun,
})

beforeEach(() => { vi.clearAllMocks() })

describe('defineTool', () => {
  it('returns the tool frozen with the defaults filled in', () => {
    expect(Object.isFrozen(echo)).toBe(true)
    expect(echo.writes).toBe(false)
    expect(echo.alwaysAvailable).toBe(false)
  })

  it('refuses an inputSchema without studio_id', () => {
    expect(() => defineTool({
      name: 'x', title: 'X', description: 'x', inputSchema: z.object({}), gate: () => true, run: async () => ({}),
    })).toThrow(/studio_id/)
  })
})

describe('runTool', () => {
  it('runs a tool for a manager at an enabled studio and records ok', async () => {
    const { db, inserts } = fakeDb()
    const r = await runTool(echo, { text: 'hi' }, fakeAuth(), { db })
    expect(r).toEqual({ ok: true, data: { text: 'hi' } })
    expect(db.rpc).toHaveBeenCalledWith('rate_limit_hit', expect.objectContaining({ p_key: 'mcp:user-1', p_window_ms: 60_000 }))
    const ctx = echoRun.mock.calls[0][1]
    expect(ctx.studio.id).toBe(A)
    expect(ctx.role).toBe('manager')
    expect(ctx.zone).toBe('Europe/Dublin')
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.db).toBe(db)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('mcp_tool_calls')
    expect(inserts[0].row).toMatchObject({
      profile_id: 'user-1', organization_id: ORG1, location_id: A, client_id: 'client-1',
      tool: 'echo', ok: true, error_code: null,
    })
    expect(inserts[0].row.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('answers invalid_input with the zod message after the rate-limit check, and records it', async () => {
    const { db, inserts } = fakeDb()
    const r = await runTool(echo, { text: 42 }, fakeAuth(), { db })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('invalid_input')
    expect(r.message).toMatch(/text/)
    // The limiter ran first (a malformed call counts), then nothing else touched the db.
    expect(db.rpc).toHaveBeenCalledWith('rate_limit_hit', expect.objectContaining({ p_key: 'mcp:user-1' }))
    expect(echoRun).not.toHaveBeenCalled()
    // The audit row is the only write, and it names no studio (none was resolved).
    expect(inserts.map((i) => i.table)).toEqual(['mcp_tool_calls'])
    expect(inserts[0].row).toMatchObject({ ok: false, error_code: 'invalid_input', location_id: null, organization_id: null })
  })

  it('answers forbidden at a studio where the gate says no and records the code', async () => {
    const { db, inserts } = fakeDb()
    const r = await runTool(echo, { studio_id: B, text: 'hi' }, fakeAuth({ enabledOrgIds: [ORG1, ORG2] }), { db })
    expect(r).toEqual({ ok: false, code: 'forbidden', message: 'The role held at Studio B does not allow Echo.' })
    expect(echoRun).not.toHaveBeenCalled()
    expect(inserts[0].row).toMatchObject({ ok: false, error_code: 'forbidden', location_id: B, organization_id: ORG2 })
  })

  it('runTool refuses a studio whose organisation has MCP off', async () => {
    const { db, inserts } = fakeDb()
    const auth = fakeAuth()
    const off = await runTool(echo, { studio_id: B, text: 'hi' }, auth, { db })
    expect(off).toEqual({
      ok: false, code: 'mcp_disabled', message: 'MCP is not switched on for this organisation. Ask an organisation admin.',
    })
    expect(echoRun).not.toHaveBeenCalled()
    expect(inserts[0].row).toMatchObject({ ok: false, error_code: 'mcp_disabled', location_id: B })

    // …while the same person's switched-on studio works.
    const on = await runTool(echo, { studio_id: A, text: 'hi' }, auth, { db })
    expect(on.ok).toBe(true)
  })

  it('lets an alwaysAvailable tool run where MCP is off', async () => {
    const { db } = fakeDb()
    const open = defineTool({ ...echo, name: 'open', gate: () => true, alwaysAvailable: true })
    const r = await runTool(open, { studio_id: B, text: 'hi' }, fakeAuth(), { db })
    expect(r.ok).toBe(true)
  })

  it('answers the studio code for a foreign studio id', async () => {
    const { db } = fakeDb()
    const r = await runTool(echo, { studio_id: '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a99', text: 'hi' }, fakeAuth(), { db })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('studio_not_found')
    expect(typeof r.message).toBe('string')
  })

  it('answers rate_limited when checkRateLimit says no', async () => {
    const { db } = fakeDb({ rateCount: 121 })
    const r = await runTool(echo, { text: 'hi' }, fakeAuth(), { db })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('rate_limited')
    expect(echoRun).not.toHaveBeenCalled()
  })

  it('does not record a rate_limited refusal (the limiter is the bound on rows)', async () => {
    const { db, inserts } = fakeDb({ rateCount: 121 })
    await runTool(echo, { text: 'hi' }, fakeAuth(), { db })
    expect(inserts).toEqual([])
    expect(db.from).not.toHaveBeenCalled()
  })

  it('throttles a malformed call too, and records nothing once limited', async () => {
    const { db, inserts } = fakeDb({ rateCount: 121 })
    const r = await runTool(echo, { text: 42 }, fakeAuth(), { db })
    expect(r.code).toBe('rate_limited')
    expect(inserts).toEqual([])
  })

  it('turns a thrown run into tool_failed and still records the call', async () => {
    const { db, inserts } = fakeDb()
    const boom = defineTool({ ...echo, name: 'boom', run: async () => { throw new Error('db down') } })
    const r = await runTool(boom, { text: 'hi' }, fakeAuth(), { db })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('tool_failed')
    expect(r.message).not.toMatch(/db down/)
    expect(logError).toHaveBeenCalledWith('mcp', expect.any(String), expect.objectContaining({ tool: 'boom' }))
    expect(inserts[0].row).toMatchObject({ tool: 'boom', ok: false, error_code: 'tool_failed', location_id: A })
  })

  it('turns a thrown ToolRefusal from run into its own code, recorded and not logged as an error', async () => {
    const { db, inserts } = fakeDb()
    const refuse = defineTool({ ...echo, name: 'refuse', run: async () => { throw new ToolRefusal('not_found', 'No such person.') } })
    const r = await runTool(refuse, { text: 'hi' }, fakeAuth(), { db })
    expect(r).toEqual({ ok: false, code: 'not_found', message: 'No such person.' })
    expect(logError).not.toHaveBeenCalled()
    expect(inserts[0].row).toMatchObject({ tool: 'refuse', ok: false, error_code: 'not_found', location_id: A })
  })

  it('turns a thrown ToolRefusal from gate into its own code too', async () => {
    const { db, inserts } = fakeDb()
    const refuse = defineTool({ ...echo, name: 'gated', gate: () => { throw new ToolRefusal('forbidden', 'Not for you.') } })
    const r = await runTool(refuse, { text: 'hi' }, fakeAuth(), { db })
    expect(r).toEqual({ ok: false, code: 'forbidden', message: 'Not for you.' })
    expect(echoRun).not.toHaveBeenCalled()
    expect(inserts[0].row).toMatchObject({ error_code: 'forbidden' })
  })

  it('keeps a plain Error named like a refusal as tool_failed', async () => {
    const { db } = fakeDb()
    const fake = defineTool({ ...echo, name: 'fake', run: async () => { throw Object.assign(new Error('x'), { name: 'ToolRefusal', code: 'forbidden' }) } })
    const r = await runTool(fake, { text: 'hi' }, fakeAuth(), { db })
    expect(r.code).toBe('tool_failed')
  })
})

describe('runTool assistant_permission wording', () => {
  it('names the studio case and the default case differently', async () => {
    const { db } = fakeDb()
    const auth = fakeAuth()
    auth.extra.user.assignmentsByLocation[B].permissions = {}
    const named = await runTool(echo, { studio_id: B, text: 'hi' }, auth, { db })
    expect(named).toMatchObject({ ok: false, code: 'assistant_permission', message: 'The AI Assistant permission is not held at that studio.' })

    auth.extra.user.rolesByLocation = { [A]: 'staff', [B]: 'staff' }
    auth.extra.user.assignmentsByLocation[A] = { role: 'staff', permissions: {} }
    const fallback = await runTool(echo, { text: 'hi' }, auth, { db })
    expect(fallback).toMatchObject({ ok: false, code: 'assistant_permission', message: 'No studio where the AI Assistant permission is held.' })
  })
})

describe('toolResult', () => {
  it('toolResult marks errors isError and serialises data as text', () => {
    expect(toolResult({ ok: true, data: { a: 1 } })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] })
    expect(toolResult({ ok: false, code: 'forbidden', message: 'No.' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'forbidden', message: 'No.' }) }],
    })
  })

  it('renders a run that returned undefined as the string "null"', () => {
    expect(toolResult({ ok: true, data: undefined })).toEqual({ content: [{ type: 'text', text: 'null' }] })
  })
})
