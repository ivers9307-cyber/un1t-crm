// STAFFPROFILEPICK.1 — the master toggle echoed `.update(...).select()`: the
// whole profiles row (pin_hash, UniFi id, pay, bookkeeping) as JSON. Neither
// caller (AdminAccessMatrix, UserAssignmentsPanel) reads `data`; it now
// names five identity columns. Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/assignment-changes', () => ({
  wouldLeaveZeroMasters: vi.fn(async () => ({ wouldLeave: false, currentMasters: 2, targetIsActiveMaster: true })),
  logAssignmentChange: vi.fn(async () => {}),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ID = 'd0000000-0000-4000-8000-000000000004'
const WHOLE = {
  id: ID, full_name: 'A Person', email: 'person@example.test', active: true, avatar_url: null,
  pin_hash: 'SYNTH-PIN-HASH', unifi_user_id: 'SYNTH-UU', annual_salary: 40000, home_screen_path: '/x',
}

function makeDb(role) {
  const calls = { echoSelects: [] }
  const db = {
    from(table) {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { id: ID, role, active: true, full_name: 'A Person', email: 'person@example.test' }, error: null }) }) }),
        update: (patch) => ({
          eq: () => ({
            select: (cols) => {
              calls.echoSelects.push(cols)
              // The fake returns the WHOLE row whatever the select says.
              return { single: async () => ({ data: { ...WHOLE, ...patch }, error: null }) }
            },
          }),
        }),
      }
    },
  }
  return { db, calls }
}

const post = (body) => POST(new Request('http://localhost/api/admin/master-toggle', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'm1', profileRole: 'master', isMaster: true })
})

describe('POST /api/admin/master-toggle — STAFFPROFILEPICK.1: the echo names its columns', () => {
  it.each([
    ['promote', 'staff', { action: 'promote', profile_id: ID }],
    ['demote', 'master', { action: 'demote', profile_id: ID }],
  ])('%s echoes id, full_name, email, role, active only', async (_name, role, body) => {
    const { db, calls } = makeDb(role)
    createServerClient.mockReturnValue(db)
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(calls.echoSelects).toEqual(['id, full_name, email, role, active'])
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(Object.keys(json.data).sort()).toEqual(['active', 'email', 'full_name', 'id', 'role'])
    expect(JSON.stringify(json)).not.toMatch(/SYNTH-|pin_|annual_salary|home_screen_path/)
  })
})
