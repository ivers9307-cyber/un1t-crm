import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

// whoami reports which tools the person may call, so give it a registry with
// one tool per outcome: whoami itself, a manager-only tool, a tool nobody
// passes, and an open tool (alwaysAvailable) to set against an org that is off.
vi.mock('./index.js', async () => {
  const { default: whoami } = await import('./whoami.js')
  const { isManagerAt } = await import('@/lib/mcp/context')
  return {
    TOOLS: [
      whoami,
      { name: 'manager_tool', alwaysAvailable: false, gate: (u, s) => isManagerAt(u, s) },
      { name: 'nobody_tool', alwaysAvailable: false, gate: () => false },
    ],
  }
})

import whoami from './whoami.js'
import { runTool } from './registry.js'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const NYC = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'

// 2026-11-02 02:00 UTC: already the 2nd in Dublin (GMT), still the 1st in New York (EST).
const NOW_MS = Date.UTC(2026, 10, 2, 2, 0, 0)

function fakeDb() {
  return {
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
  }
}

function auth() {
  const locations = [
    { id: DUB, name: 'Dublin Studio', timezone: 'Europe/Dublin', organization_id: 'org-1', settings: { secret_token: 'x' } },
    { id: NYC, name: 'New York Studio', timezone: 'America/New_York', organization_id: 'org-2', settings: { secret_token: 'y' } },
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
        rolesByLocation: { [DUB]: 'manager', [NYC]: 'staff' },
        assignmentsByLocation: {
          [DUB]: { role: 'manager', permissions: {} },
          [NYC]: { role: 'staff', permissions: {} },
        },
      },
      enabledOrgIds: ['org-1'],
      assistantAnywhere: true,
    },
  }
}

describe('whoami', () => {
  it('is always available and open to anyone', () => {
    expect(whoami.name).toBe('whoami')
    expect(whoami.alwaysAvailable).toBe(true)
    expect(whoami.writes).toBe(false)
    expect(whoami.gate({}, 'any')).toBe(true)
  })

  it('lists every studio with role, today in its zone and mcp_enabled, and the callable tool names', async () => {
    const r = await runTool(whoami, {}, auth(), { db: fakeDb(), nowMs: NOW_MS })
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({
      name: 'Pat Manager',
      default_studio_id: DUB,
      studios: [
        { id: DUB, name: 'Dublin Studio', timezone: 'Europe/Dublin', role: 'manager', today: '2026-11-02', mcp_enabled: true, assistant: true },
        { id: NYC, name: 'New York Studio', timezone: 'America/New_York', role: 'staff', today: '2026-11-01', mcp_enabled: false, assistant: false },
      ],
      tools: ['whoami', 'manager_tool'],
    })
  })

  it('answers when the default studio has MCP off, naming only the always-available tools', async () => {
    const a = auth()
    a.extra.enabledOrgIds = []
    const r = await runTool(whoami, {}, a, { db: fakeDb(), nowMs: NOW_MS })
    expect(r.ok).toBe(true)
    expect(r.data.tools).toEqual(['whoami'])
    expect(r.data.studios.map((s) => s.mcp_enabled)).toEqual([false, false])
  })
})
