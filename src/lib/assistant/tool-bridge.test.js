// ASSISTREG.2 — the bridge's own guarantees, independent of any one tool:
// the studio is the session's, the model cannot name one, a refusal reads as
// { error }, and nothing here touches mcp_tool_calls.

import { describe, it, expect } from 'vitest'
import {
  allowedBridgedToolDefinitions,
  assistantToolSchema,
  bridgedToolDefinitions,
  isBridgedTool,
  runAssistantTool,
  BRIDGED_TOOL_NAMES,
} from './tool-bridge.js'

const STUDIO = { id: 'loc-a', name: 'Stillorgan', organization_id: 'org-1', timezone: 'Europe/Dublin' }
const OTHER = 'loc-b-0000-0000-0000-000000000000'

// A manager at loc-a and nowhere else.
function manager() {
  return {
    id: 'u-1',
    isMaster: false,
    rolesByLocation: { 'loc-a': 'manager' },
    activeLocation: STUDIO,
  }
}

// Records every table touched and the filters applied, so a test can assert
// what the query was scoped to — and that mcp_tool_calls is never written.
function makeDb(rows = {}) {
  const seen = []
  function builder(table) {
    const state = { table, filters: [], op: 'select' }
    seen.push(state)
    const chain = {
      select() { return chain },
      insert(payload) { state.op = 'insert'; state.payload = payload; return chain },
      eq(col, val) { state.filters.push([col, val]); return chain },
      in(col, val) { state.filters.push([col, val]); return chain },
      lte(col, val) { state.filters.push([col, val]); return chain },
      gte(col, val) { state.filters.push([col, val]); return chain },
      order() { return chain },
      limit() { return chain },
      maybeSingle() { return Promise.resolve({ data: (rows[table] || [])[0] ?? null, error: null }) },
      single() { return Promise.resolve({ data: (rows[table] || [])[0] ?? null, error: null }) },
      then(onF, onR) { return Promise.resolve({ data: rows[table] || [], error: null }).then(onF, onR) },
    }
    return chain
  }
  return { from: (t) => builder(t), _seen: seen }
}

describe('assistantToolSchema', () => {
  it('strips studio_id so the model is never offered a studio', () => {
    const schema = assistantToolSchema('search_contacts')
    expect(schema.properties.studio_id).toBeUndefined()
    expect(schema.properties.query).toBeDefined()
    expect(schema.required || []).not.toContain('studio_id')
  })

  it('derives a schema for every bridged tool, refinements included', () => {
    // get_shifts and the reports carry .superRefine, on which zod's .omit()
    // throws — this pins the JSON-Schema-level removal that avoids it.
    for (const name of BRIDGED_TOOL_NAMES) {
      const schema = assistantToolSchema(name)
      expect(schema.type, name).toBe('object')
      expect(schema.properties.studio_id, name).toBeUndefined()
    }
  })

  it('offers every bridged tool to Anthropic with a name, description and schema', () => {
    const defs = bridgedToolDefinitions()
    expect(defs).toHaveLength(BRIDGED_TOOL_NAMES.length)
    for (const d of defs) {
      expect(d.name).toBeTruthy()
      expect(d.description.length).toBeGreaterThan(20)
      expect(d.input_schema.type).toBe('object')
    }
  })

  it('knows get_shifts_for_week is gone and get_shifts replaced it', () => {
    expect(isBridgedTool('get_shifts')).toBe(true)
    expect(isBridgedTool('get_shifts_for_week')).toBe(false)
  })
})

describe('runAssistantTool — the studio is the session’s, not the model’s', () => {
  it('scopes to the active location even when the model supplies another studio_id', async () => {
    const db = makeDb({ time_off_requests: [] })
    const res = await runAssistantTool(
      'get_time_off',
      { start: '2026-11-01', end: '2026-11-07', studio_id: OTHER },
      { db, user: manager() },
    )
    expect(res.error).toBeUndefined()
    expect(res.studio).toEqual({ id: 'loc-a', name: 'Stillorgan' })
    const timeOff = db._seen.find(s => s.table === 'time_off_requests')
    expect(timeOff.filters).toContainEqual(['location_id', 'loc-a'])
    // The smuggled studio must appear nowhere in the query.
    expect(JSON.stringify(timeOff.filters)).not.toContain(OTHER)
  })

  it('never writes an mcp_tool_calls row (that table is the MCP connect signal)', async () => {
    const db = makeDb({ time_off_requests: [] })
    await runAssistantTool('get_time_off', { start: '2026-11-01', end: '2026-11-07' }, { db, user: manager() })
    expect(db._seen.map(s => s.table)).not.toContain('mcp_tool_calls')
  })

  it('answers { error } when there is no active location, never an unscoped read', async () => {
    const db = makeDb({ time_off_requests: [] })
    const res = await runAssistantTool(
      'get_time_off',
      { start: '2026-11-01', end: '2026-11-07' },
      { db, user: { ...manager(), activeLocation: null } },
    )
    expect(res.error).toMatch(/no active location/i)
    expect(db._seen).toHaveLength(0)
  })

  it('turns invalid input into { error }, and runs nothing', async () => {
    const db = makeDb({ time_off_requests: [] })
    const res = await runAssistantTool('get_time_off', { start: 'not-a-date' }, { db, user: manager() })
    expect(res.error).toBeTruthy()
    expect(db._seen).toHaveLength(0)
  })

  it('refuses an unknown tool name', async () => {
    const res = await runAssistantTool('nope', {}, { db: makeDb(), user: manager() })
    expect(res.error).toMatch(/unknown tool/i)
  })
})

// ASSISTREG.2 — what the gate swap actually changes, tool by tool. The old
// TOOL_PERMISSIONS map judged role alone; these gates are the registry's.
//
// ASSISTREG.3 — and the assistant's historical tiers are kept as FLOORS under
// those gates, so effective access is the INTERSECTION: the swap can narrow
// what the assistant grants, never widen it. Without the floor it DID widen
// one tool — `contacts` defaults TRUE for every role including staff, and the
// registry gates search_contacts on that key with no role floor, where the
// assistant has always demanded the manager tier. The MCP server keeps the
// unfloored gate, which is why the floor lives in the door, not the tool.
describe('runAssistantTool — the gates are the registry’s now', () => {
  const STUDIO2 = { id: 'loc-a', name: 'Stillorgan', organization_id: 'org-1', timezone: 'Europe/Dublin' }
  function userWith(role, permissions = {}) {
    return {
      id: 'u-1',
      isMaster: false,
      rolesByLocation: { 'loc-a': role },
      assignmentsByLocation: { 'loc-a': { role, permissions } },
      activeLocation: STUDIO2,
      permissions: {},
    }
  }
  const db = () => ({ from: () => { throw new Error('no read expected') } })

  it('refuses it once Contacts is switched off for that person at that studio', async () => {
    const res = await runAssistantTool('search_contacts', { query: 'alice' }, {
      db: db(), user: userWith('manager', { contacts: false }),
    })
    expect(res.error).toMatch(/does not allow/i)
  })

  it('bridges create_contact and create_activity, and keeps their tier floors', async () => {
    // ASSISTREG.3 — these two were unbridgeable while readableContactStudios
    // demanded mcp_access and the MCP org switch inside the body. The door
    // supplies the list now, so they bridge; their historical tiers stay as
    // floors, so nobody gains access who did not have it.
    expect(isBridgedTool('create_contact')).toBe(true)
    expect(isBridgedTool('create_activity')).toBe(true)
    // head_coach cleared 'manager' but never 'admin'.
    const hc = await runAssistantTool('create_contact', { name: 'X', email: 'x@x.com' }, {
      db: db(), user: userWith('head_coach'),
    })
    expect(hc.error).toMatch(/permission denied/i)
    const staff = await runAssistantTool('create_activity', { subject: 'S', type: 'call' }, {
      db: db(), user: userWith('staff'),
    })
    expect(staff.error).toMatch(/permission denied/i)
  })

  it('keeps search_contacts at the manager tier — the swap must not widen it', async () => {
    // The registry gate is Contacts alone (no role floor), and Contacts
    // defaults TRUE for staff, so without the floor a staff member would gain
    // assistant contact search. The MCP server keeps the unfloored gate.
    const res = await runAssistantTool('search_contacts', { query: 'alice' }, {
      db: db(), user: userWith('staff'),
    })
    expect(res.error).toMatch(/permission denied/i)
    expect(allowedBridgedToolDefinitions(userWith('staff')).map(d => d.name)).not.toContain('search_contacts')
  })

  it('still refuses a staff member create_shift and list_staff', async () => {
    for (const [name, input] of [['create_shift', { date: '2026-11-02' }], ['list_staff', {}]]) {
      const res = await runAssistantTool(name, input, { db: db(), user: userWith('staff') })
      expect(res.error, name).toMatch(/permission denied|does not allow/i)
    }
  })

  it('offers a staff member only the tools their gates admit', async () => {
    const names = allowedBridgedToolDefinitions(userWith('staff')).map(d => d.name)
    expect(names).toContain('get_shifts')
    expect(names).toContain('get_time_off')
    expect(names).not.toContain('search_contacts')  // floored at manager
    expect(names).not.toContain('create_shift')
    expect(names).not.toContain('list_staff')
  })

  it('offers a manager the write tools too', async () => {
    const names = allowedBridgedToolDefinitions(userWith('manager')).map(d => d.name)
    for (const n of ['create_shift', 'list_staff', 'list_shift_templates', 'search_contacts', 'create_activity', 'create_contact']) {
      expect(names, n).toContain(n)
    }
  })
})
