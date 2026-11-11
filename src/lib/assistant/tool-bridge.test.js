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
// 🔴 The one MATERIAL access change is search_contacts, and it is a WIDENING,
// not the tightening it looks like: `contacts` defaults to TRUE for every
// role including staff, and the registry gates search_contacts on that key
// with NO role floor, where the assistant demanded the manager tier. So a
// plain staff member can now search contacts through the assistant — which is
// consistent with the Contacts screen they can already open, and with the MCP
// server. Pinned here so the change is visible and reversible: putting a
// manager floor back is one clause in search-contacts.js's gate.
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

  it('lets a STAFF member search contacts, because Contacts defaults true for every role', async () => {
    const res = await runAssistantTool('search_contacts', { query: 'alice' }, {
      db: { from: () => ({ select: () => ({ eq: () => ({ or: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }) }) },
      user: userWith('staff'),
    })
    expect(res.error).toBeUndefined()
  })

  it('refuses it once Contacts is switched off for that person at that studio', async () => {
    const res = await runAssistantTool('search_contacts', { query: 'alice' }, {
      db: db(), user: userWith('manager', { contacts: false }),
    })
    expect(res.error).toMatch(/does not allow/i)
  })

  it('does NOT bridge create_contact or create_activity', async () => {
    // Their registry bodies resolve the contact through readableContactStudios,
    // which demands mcp_access AND the org's mcp_enabled switch — door
    // concerns baked into a body. Bridged as-is they would refuse every
    // manager and everything at CCF Autos (MCPACCESS.1 from the other side),
    // so the chat route still owns them. This pins that boundary: if someone
    // adds them to BRIDGED_TOOL_NAMES without moving that pair out of the
    // helper first, this fails.
    for (const name of ['create_contact', 'create_activity']) {
      expect(isBridgedTool(name), name).toBe(false)
      const res = await runAssistantTool(name, {}, { db: db(), user: userWith('manager') })
      expect(res.error, name).toMatch(/unknown tool/i)
    }
  })

  it('still refuses a staff member create_shift and list_staff', async () => {
    for (const [name, input] of [['create_shift', { date: '2026-11-02' }], ['list_staff', {}]]) {
      const res = await runAssistantTool(name, input, { db: db(), user: userWith('staff') })
      expect(res.error, name).toMatch(/does not allow|required|invalid/i)
    }
  })

  it('offers a staff member only the tools their gates admit', async () => {
    const names = allowedBridgedToolDefinitions(userWith('staff')).map(d => d.name)
    expect(names).toContain('get_shifts')
    expect(names).toContain('get_time_off')
    expect(names).toContain('search_contacts')   // the widening, stated out loud
    expect(names).not.toContain('create_shift')
    expect(names).not.toContain('list_staff')
  })

  it('offers a manager the write tools too', async () => {
    const names = allowedBridgedToolDefinitions(userWith('manager')).map(d => d.name)
    for (const n of ['create_shift', 'list_staff', 'list_shift_templates']) {
      expect(names, n).toContain(n)
    }
  })
})
