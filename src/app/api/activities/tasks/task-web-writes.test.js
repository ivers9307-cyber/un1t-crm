// C148 ACTWRITEGATEWEB.1 — the web task writes, judged on the WEB rule.
//   POST /api/activities/tasks              create a task at a studio
//   POST /api/activities/tasks/[id]/status  move a task between columns
// The rule (canWriteActivitiesAt): the web Tasks key (`activities`) AND
// Contacts (web or phone) at the row's studio. The phone Tasks / Pipeline
// keys, which the RLS write policies (mig 691) judge, do not enter into it.
// A contact must be at the studio the task lands at; an assignee must work
// there. Every error is read; a zero-row write is not a success.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'
import { POST as createTask } from './route.js'
import { POST as setStatus } from './[id]/status/route.js'

const C1 = 'c1000000-0000-4000-8000-000000000001'
const P1 = 'f1000000-0000-4000-8000-000000000001'
const T1 = 'a1000000-0000-4000-8000-000000000001'
const FORBIDDEN = { status: 403, body: { success: false, error: 'No Tasks permission at this location' } }
const req = (body) => new Request('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: Promise.resolve({ id: T1 }) }

// Web Tasks + web Contacts at B, neither phone key: the person RLS refused.
const WEB_ONLY = person({ [LOC_B]: { role: 'staff', permissions: { activities: true, contacts: true, mobile: { tasks: false, pipeline: false, contacts: false } } } }, LOC_B)
const PHONE_ONLY = person({ [LOC_B]: { role: 'staff', permissions: { activities: false, contacts: true, mobile: { tasks: true, pipeline: true, contacts: true } } } }, LOC_B)
const NO_CONTACTS_B = person({ [LOC_B]: { role: 'owner', permissions: { activities: true, contacts: false, mobile: { contacts: false, tasks: true } } } }, LOC_B)
const TASKS_AT_A_ONLY = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner', permissions: { activities: false } } }, LOC_A)
const OUTSIDER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)

let tables
let reads
function trackedDb() {
  const real = makeFakeDb(tables)
  return { from: (t) => { reads.push(t); return real.from(t) } }
}
// A db whose `table` answers `answer` at the terminal call (read or write).
function dbFailing(table, answer, { onWrite = false } = {}) {
  const real = makeFakeDb(tables)
  return { from: (t) => {
    const b = real.from(t)
    if (t !== table) return b
    const fail = () => {
      b.then = (res, rej) => Promise.resolve(answer).then(res, rej)
      b.single = async () => answer
      b.maybeSingle = async () => answer
    }
    if (onWrite) {
      for (const op of ['insert', 'update']) { const orig = b[op]; b[op] = (p) => { orig(p); fail(); return b } }
    } else fail()
    return b
  } }
}

beforeEach(() => {
  vi.clearAllMocks()
  reads = []
  getCurrentUser.mockResolvedValue(WEB_ONLY)
  tables = {
    contacts: [{ id: C1, location_id: LOC_B }],
    profile_locations: [{ profile_id: P1, location_id: LOC_B }],
    activities: [],
  }
  createServerClient.mockImplementation(() => trackedDb())
})

const BODY = { location_id: LOC_B, subject: 'Call back about the trial' }

describe('POST /api/activities/tasks', () => {
  it('web Tasks + Contacts with neither phone key: 200, a task row at the studio', async () => {
    const res = await createTask(req({ ...BODY, contact_id: C1, assignee_id: P1, type: 'email', due_date: '2026-10-09', due_time: '09:30', note: 'n', priority: 'high', project: 'Trials' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(tables.activities).toHaveLength(1)
    expect(tables.activities[0]).toEqual({
      location_id: LOC_B, subject: 'Call back about the trial', kind: 'task', status: 'todo', source: 'crm',
      contact_id: C1, assignee_id: P1, type: 'email', due_date: '2026-10-09', due_time: '09:30', note: 'n', priority: 'high', project: 'Trials',
    })
  })

  it('a bare task (no contact, no assignee) needs no link reads', async () => {
    const res = await createTask(req(BODY))
    expect(res.status).toBe(200)
    expect(reads).toEqual(['activities'])
  })

  it('the client cannot choose kind, source, status or a deal', async () => {
    await createTask(req({ ...BODY, kind: 'event', source: 'glofox', status: 'done', deal_id: C1 }))
    expect(tables.activities[0]).toMatchObject({ kind: 'task', source: 'crm', status: 'todo' })
    expect(tables.activities[0]).not.toHaveProperty('deal_id')
  })

  it('phone Tasks/Pipeline without web Tasks anywhere: 403 before any read', async () => {
    getCurrentUser.mockResolvedValue(PHONE_ONLY)
    const res = await createTask(req(BODY))
    expect({ status: res.status, body: await res.json() }).toEqual(FORBIDDEN)
    expect(reads).toEqual([])
  })

  it('Contacts off at the studio (web and phone): 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(NO_CONTACTS_B)
    const res = await createTask(req(BODY))
    expect({ status: res.status, body: await res.json() }).toEqual(FORBIDDEN)
    expect(tables.activities).toEqual([])
  })

  it('web Tasks at the ACTIVE studio but off at the target: 403', async () => {
    getCurrentUser.mockResolvedValue(TASKS_AT_A_ONLY)
    const res = await createTask(req(BODY))
    expect({ status: res.status, body: await res.json() }).toEqual(FORBIDDEN)
    expect(tables.activities).toEqual([])
  })

  it('not a member of the studio: 403 (the body-location shape), nothing read', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await createTask(req(BODY))
    expect(res.status).toBe(403)
    expect(reads).toEqual([])
  })

  it('a master: 200', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await createTask(req(BODY))).status).toBe(200)
  })

  it('a contact at ANOTHER studio: 404, nothing written', async () => {
    tables.contacts[0].location_id = LOC_A
    const res = await createTask(req({ ...BODY, contact_id: C1 }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not at this studio/i)
    expect(tables.activities).toEqual([])
  })

  it('a missing contact: 404', async () => {
    tables.contacts = []
    expect((await createTask(req({ ...BODY, contact_id: C1 }))).status).toBe(404)
    expect(tables.activities).toEqual([])
  })

  it('a failed contact read: 500, nothing written', async () => {
    createServerClient.mockImplementation(() => dbFailing('contacts', { data: null, error: { code: '57014', message: 'timeout' } }))
    expect((await createTask(req({ ...BODY, contact_id: C1 }))).status).toBe(500)
    expect(tables.activities).toEqual([])
  })

  it('an assignee who does not work at the studio: 400, nothing written', async () => {
    tables.profile_locations[0].location_id = LOC_A
    const res = await createTask(req({ ...BODY, assignee_id: P1 }))
    expect(res.status).toBe(400)
    expect(tables.activities).toEqual([])
  })

  it('a failed assignee read: 500', async () => {
    createServerClient.mockImplementation(() => dbFailing('profile_locations', { data: null, error: { code: '57014', message: 'timeout' } }))
    expect((await createTask(req({ ...BODY, assignee_id: P1 }))).status).toBe(500)
    expect(tables.activities).toEqual([])
  })

  it('a failed insert: 500 with an error, never a success', async () => {
    createServerClient.mockImplementation(() => dbFailing('activities', { data: null, error: { code: '23514', message: 'check' } }, { onWrite: true }))
    const res = await createTask(req(BODY))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it.each([
    ['no subject', { location_id: LOC_B }],
    ['no studio', { subject: 'x' }],
    ['a bad date', { ...BODY, due_date: '9 Oct' }],
    ['a bad priority', { ...BODY, priority: 'asap' }],
  ])('%s: 400', async (_l, body) => {
    expect((await createTask(req(body))).status).toBe(400)
  })

  it('no session: 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await createTask(req(BODY))).status).toBe(401)
  })
})

describe('POST /api/activities/tasks/[id]/status', () => {
  beforeEach(() => {
    tables.activities = [{ id: T1, kind: 'task', status: 'todo', location_id: LOC_B, contact_id: null }]
  })

  it.each(['in_progress', 'done', 'cancelled', 'todo'])('web Tasks + Contacts, neither phone key: → %s', async (to) => {
    const res = await setStatus(req({ status: to }), props)
    expect(res.status).toBe(200)
    expect(tables.activities[0].status).toBe(to)
  })

  it('phone keys without web Tasks anywhere: 403 before any read', async () => {
    getCurrentUser.mockResolvedValue(PHONE_ONLY)
    const res = await setStatus(req({ status: 'done' }), props)
    expect({ status: res.status, body: await res.json() }).toEqual(FORBIDDEN)
    expect(reads).toEqual([])
  })

  it('Contacts off at the task\'s studio: 403, unchanged', async () => {
    getCurrentUser.mockResolvedValue(NO_CONTACTS_B)
    const res = await setStatus(req({ status: 'done' }), props)
    expect({ status: res.status, body: await res.json() }).toEqual(FORBIDDEN)
    expect(tables.activities[0].status).toBe('todo')
  })

  it('judged at the TASK\'s studio, not the active one', async () => {
    getCurrentUser.mockResolvedValue(TASKS_AT_A_ONLY)
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(403)
    tables.activities[0].location_id = LOC_A
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(200)
  })

  it('a task at a studio the caller does not belong to: 404', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(404)
    expect(tables.activities[0].status).toBe('todo')
  })

  it('a missing row, an auto-logged event row, or a row with no studio: 404', async () => {
    tables.activities[0].kind = 'event'
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(404)
    tables.activities[0] = { id: T1, kind: 'task', status: 'todo', location_id: null }
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(404)
    tables.activities = []
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(404)
  })

  it('a failed read: 500, not a 404', async () => {
    createServerClient.mockImplementation(() => dbFailing('activities', { data: null, error: { code: '57014', message: 'timeout' } }))
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(500)
  })

  it('a failed write: 500', async () => {
    createServerClient.mockImplementation(() => dbFailing('activities', { data: null, error: { code: '57014', message: 'timeout' } }, { onWrite: true }))
    expect((await setStatus(req({ status: 'done' }), props)).status).toBe(500)
  })

  it('a write that matched no row: 404, never a success', async () => {
    createServerClient.mockImplementation(() => dbFailing('activities', { data: [], error: null }, { onWrite: true }))
    const res = await setStatus(req({ status: 'done' }), props)
    expect(res.status).toBe(404)
    expect((await res.json()).success).toBe(false)
  })

  it('an unknown status: 400', async () => {
    expect((await setStatus(req({ status: 'archived' }), props)).status).toBe(400)
  })
})
