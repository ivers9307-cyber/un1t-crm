// C148 ACTWRITEGATEWEB.1 — the two web task writes, judged on the WEB Tasks
// key (`activities`) at the task's studio, never the active one, and never
// the phone Tasks / Pipeline keys the RLS write policies (mig 691) judge.
//   POST /api/activities/tasks              (the body's studio)
//   POST /api/activities/tasks/[id]/status  (the task's own studio)
// The Contacts half of the rule and the route bodies:
// src/app/api/activities/tasks/task-web-writes.test.js.
// Harness: tests/helpers/role-gate-probe.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { describeGate } from '../helpers/role-gate-probe.js'
import { permissionCases } from '../helpers/role-sweep-callers.js'
import * as createTask from '@/app/api/activities/tasks/route.js'
import * as taskStatus from '@/app/api/activities/tasks/[id]/status/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (body) => new Request('http://localhost/api/x', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const params = (p) => ({ params: Promise.resolve(p) })
const TASK_ID = 'a1000000-0000-4000-8000-000000000001'
const FORBIDDEN = { status: 403, body: { success: false, error: 'No Tasks permission at this location' } }
const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const BODY_HIDDEN = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
// Before C148 these were browser writes: RLS judged the phone keys, and the
// page's own gate was the ACTIVE studio's web key.
const cases = permissionCases('activities').map(([label, ...rest]) => [label.replace(/ \(main: [a-z]+\)$/, ''), ...rest])

beforeEach(() => vi.clearAllMocks())

describeGate('POST /api/activities/tasks (web Tasks at the studio it creates at)', {
  call: (loc) => createTask.POST(json({ location_id: loc, subject: 'Call back' })),
  forbidden: FORBIDDEN, hidden: BODY_HIDDEN, cases,
}, T)
describeGate('POST /api/activities/tasks/[id]/status (web Tasks at the task)', {
  call: () => taskStatus.POST(json({ status: 'done' }), params({ id: TASK_ID })),
  gateReads: (loc) => [{ data: { id: TASK_ID, kind: 'task', status: 'todo', location_id: loc }, error: null }],
  forbidden: FORBIDDEN, hidden: NOT_FOUND, cases,
}, T)
