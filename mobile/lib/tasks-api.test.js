// C150 ACTSOURCECHECK.1 — the phone's task create stamps source 'crm'.
//
// activities_source_check (mig 138) allows only 'crm' and 'glofox'. createTask
// used to insert source 'manual', so Postgres refused every phone task create
// and the New task screen showed the raw constraint error (prod held 0
// kind='task' rows). Nothing reads 'manual' as provenance: the only reader of
// activities.source tells Glofox-synced rows apart (source === 'glofox').
// tests/activities-source-check-guard.test.js keeps every literal in the list.
//
// `./supabase` is mocked BEFORE import: it pulls the React-Native runtime,
// which must never load under vitest's Node environment.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const calls = { table: null, insert: null, select: null }
let result = { data: { id: 'task-1' }, error: null }

vi.mock('./supabase', () => {
  const chain = {
    insert: (row) => { calls.insert = row; return chain },
    select: (cols) => { calls.select = cols; return chain },
    single: async () => result,
  }
  return { supabase: { from: (t) => { calls.table = t; return chain } } }
})

import { createTask } from './tasks-api'

const LOC = '00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  calls.table = null
  calls.insert = null
  calls.select = null
  result = { data: { id: 'task-1' }, error: null }
})

describe('createTask', () => {
  it("inserts source 'crm', a value activities_source_check accepts", async () => {
    const res = await createTask({ locationId: LOC, subject: '  Call back about the trial  ' })
    expect(res).toEqual({ success: true, data: { id: 'task-1' } })
    expect(calls.table).toBe('activities')
    expect(calls.insert).toMatchObject({
      kind: 'task', status: 'todo', source: 'crm', location_id: LOC, subject: 'Call back about the trial',
    })
    expect(['crm', 'glofox']).toContain(calls.insert.source)
  })

  it('reads the row back without a profiles embed', async () => {
    await createTask({ locationId: LOC, subject: 'x' })
    expect(calls.select).not.toMatch(/profiles/)
  })

  it('passes a refusal through as an error the screen shows', async () => {
    result = { data: null, error: { message: 'new row violates row-level security policy' } }
    const res = await createTask({ locationId: LOC, subject: 'x' })
    expect(res).toEqual({ success: false, error: 'new row violates row-level security policy' })
  })

  it('refuses a blank subject or no studio before any write', async () => {
    expect((await createTask({ locationId: LOC, subject: '   ' })).success).toBe(false)
    expect((await createTask({ locationId: null, subject: 'x' })).success).toBe(false)
    expect(calls.insert).toBe(null)
  })
})
