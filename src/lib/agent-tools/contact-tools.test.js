import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/contact-studios', async (orig) => ({ ...(await orig()), studiosOfContact: vi.fn() }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn() }))

import { studiosOfContact } from '@/lib/contact-studios'
import { maybeProvisionLeadInGlofox } from '@/lib/automations/glofox-lead-provisioning'
import { triggerSequencesForContactCreated } from '@/lib/sequences/triggers'
import { runTool } from './registry.js'
import searchContacts from './search-contacts.js'
import getContact from './get-contact.js'
import listPipeline from './list-pipeline.js'
import listTasks from './list-tasks.js'
import createContact from './create-contact.js'
import createActivity from './create-activity.js'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const HATCH = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const C1 = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1e01'
const C2 = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1e02'
const NOW_MS = Date.UTC(2031, 10, 1, 12, 0, 0)

/**
 * A person at DUB (the default studio) and HATCH, same organisation.
 * `perms` are the per-user web overrides at DUB; HATCH never holds Contacts.
 */
function auth(role = 'manager', perms = {}) {
  const locations = [
    { id: DUB, name: 'Dublin Studio', timezone: 'Europe/Dublin', organization_id: 'org-1' },
    { id: HATCH, name: 'Hatch Street', timezone: 'Europe/Dublin', organization_id: 'org-1' },
  ]
  return {
    token: 't',
    clientId: 'client-1',
    scopes: [],
    extra: {
      user: {
        id: ME,
        full_name: 'Pat',
        role,
        isMaster: false,
        locations,
        activeLocation: locations[0],
        rolesByLocation: { [DUB]: role, [HATCH]: role },
        assignmentsByLocation: {
          [DUB]: { role, permissions: { assistant: true, ...perms } },
          [HATCH]: { role, permissions: { assistant: true, contacts: false } },
        },
      },
      enabledOrgIds: ['org-1'],
      assistantAnywhere: true,
    },
  }
}

/** A chainable stand-in for the supabase builder: records every call, answers from `tables`. */
function makeDb(tables = {}) {
  const queries = []
  const db = {
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [] }
      queries.push(q)
      const answer = () => {
        const t = typeof tables[table] === 'function' ? tables[table](q) : tables[table]
        return t ?? { data: [], error: null }
      }
      const b = {}
      for (const m of ['select', 'insert', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'or', 'ilike', 'order', 'limit', 'range', 'is']) {
        b[m] = (...args) => { q.calls.push([m, ...args]); return b }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  const on = (table) => queries.filter((q) => q.table === table)
  return { db, on }
}
const used = (q, method, ...args) => q.calls.some((c) => c[0] === method && args.every((a, i) => c[i + 1] === a))
const argOf = (q, method) => q.calls.find((c) => c[0] === method)
const run = (tool, input, role, db, perms) => runTool(tool, input, auth(role, perms), { db, nowMs: NOW_MS })

beforeEach(() => {
  vi.clearAllMocks()
  studiosOfContact.mockResolvedValue({ ok: true, rows: [] })
})

describe('search_contacts', () => {
  it('search_contacts sanitises the term and refuses one under the minimum length', async () => {
    const short = makeDb()
    const r1 = await run(searchContacts, { query: ' a%( ' }, 'manager', short.db)
    expect(r1).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(short.on('contacts')).toHaveLength(0)
    expect(short.on('contact_studios')).toHaveLength(0)

    const home = { id: C1, name: 'John Smith', email: 'j@x.ie', phone: null, location_id: DUB, pipeline_stage_slug: 'new_lead', lead_source: 'web' }
    const crossover = { id: C2, name: 'John Doe', email: 'jd@x.ie', phone: null, location_id: HATCH, pipeline_stage_slug: null, lead_source: 'glofox' }
    const { db, on } = makeDb({
      contacts: { data: [home], error: null },
      // C1 has its home row here too: it must come back once.
      contact_studios: { data: [{ contact_id: C1, contacts: home }, { contact_id: C2, contacts: crossover }], error: null },
    })
    const r = await run(searchContacts, { query: 'jo(h)n,%' }, 'manager', db)
    expect(r.ok).toBe(true)
    expect(r.data.contacts.map((c) => c.id)).toEqual([C1, C2])
    expect(r.data.contacts[1]).toEqual(crossover)
    expect(r.data.capped).toBe(false)

    const contactsQ = on('contacts')[0]
    expect(used(contactsQ, 'eq', 'location_id', DUB)).toBe(true)
    const filter = argOf(contactsQ, 'or')[1]
    expect(filter).toContain('%jo h n%')
    expect(filter).not.toMatch(/[()]/)
    const studiosQ = on('contact_studios')[0]
    expect(used(studiosQ, 'eq', 'location_id', DUB)).toBe(true)
    expect(argOf(studiosQ, 'or')[1]).toContain('%jo h n%')
    expect(argOf(studiosQ, 'or')[2]).toEqual({ referencedTable: 'contacts' })
  })

  it('search_contacts needs Contacts at the studio, not just a role', async () => {
    const { db, on } = makeDb()
    const r = await run(searchContacts, { query: 'john' }, 'owner', db, { contacts: false })
    expect(r).toMatchObject({ ok: false, code: 'forbidden' })
    expect(on('contacts')).toHaveLength(0)
  })
})

describe('get_contact', () => {
  it('get_contact answers not_found for a contact at a studio the person cannot read', async () => {
    // C1 is homed at HATCH (no Contacts there) and has no row at DUB.
    studiosOfContact.mockResolvedValue({ ok: true, rows: [{ contact_id: C1, location_id: HATCH, kind: 'member', status: 'active' }] })
    const hatch = makeDb({ contacts: { data: { id: C1, location_id: HATCH }, error: null } })
    const unreadable = await run(getContact, { contact_id: C1 }, 'manager', hatch.db)

    studiosOfContact.mockResolvedValue({ ok: true, rows: [] })
    const nobody = makeDb({ contacts: { data: null, error: null } })
    const missing = await run(getContact, { contact_id: C2 }, 'manager', nobody.db)

    expect(unreadable).toMatchObject({ ok: false, code: 'not_found' })
    expect(missing).toEqual(unreadable)
    // Nothing about the contact was read past the readability check.
    expect(hatch.on('notes')).toHaveLength(0)
    expect(hatch.on('deals')).toHaveLength(0)
  })

  it('get_contact timeline is capped at 20 and carries no message bodies', async () => {
    const long = 'x'.repeat(300)
    const notes = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, content: long, created_at: `2031-10-${String(10 + i).padStart(2, '0')}T10:00:00Z` }))
    const activities = Array.from({ length: 15 }, (_, i) => ({
      id: `a${i}`, type: 'whatsapp_received', subject: 'WhatsApp received', note: 'WhatsApp: secret body',
      created_at: `2031-10-${String(10 + i).padStart(2, '0')}T11:00:00Z`,
    }))
    // Crossover: homed at HATCH, readable through its DUB row.
    studiosOfContact.mockResolvedValue({
      ok: true,
      rows: [
        { contact_id: C1, location_id: DUB, kind: 'member', status: 'active', source: 'glofox', membership_plan: 'Unlimited', membership_status: 'active', membership_since: '2031-01-01', membership_ended_at: null },
        { contact_id: C1, location_id: HATCH, kind: 'lead', status: 'active', source: 'lead_form', membership_status: null },
      ],
    })
    const { db, on } = makeDb({
      contacts: (q) => (used(q, 'select', 'id, location_id')
        ? { data: { id: C1, location_id: HATCH }, error: null }
        : { data: { id: C1, name: 'Jo', email: 'jo@x.ie', phone: null, lead_source: 'web', pipeline_stage_slug: 'member', created_at: '2031-01-01T00:00:00Z' }, error: null }),
      notes: { data: notes, error: null },
      activities: { data: activities, error: null },
      deals: { data: [{ id: 'd1', title: 'Jo', status: 'open', stage_entered_at: '2031-10-01T00:00:00Z', pipelines: { name: 'Funnel' }, pipeline_stages: { name: 'Member' } }], error: null },
      class_bookings: { data: [{ starts_at: '2031-11-02T07:00:00Z', class_name: 'HIIT', status: 'BOOKED', attended: null, source_platform: 'glofox' }], error: null },
    })
    const r = await run(getContact, { contact_id: C1 }, 'manager', db)
    expect(r.ok).toBe(true)
    const { timeline } = r.data
    expect(timeline).toHaveLength(20)
    for (const item of timeline) {
      expect(Object.keys(item).sort()).toEqual(['activityType', 'date', 'subject'])
      expect(String(item.subject).length).toBeLessThanOrEqual(200)
    }
    expect(JSON.stringify(r.data)).not.toContain('secret body')
    expect(argOf(on('activities')[0], 'select')[1]).not.toMatch(/\bnote\b/)
    // Only the studios the person can read; the membership facts reshaped.
    expect(r.data.studios).toEqual([{
      location_id: DUB, kind: 'member', status: 'active', source: 'glofox',
      membership: { plan: 'Unlimited', status: 'active', since: '2031-01-01', ended_at: null },
    }])
    expect(r.data.deals).toEqual([{ id: 'd1', title: 'Jo', status: 'open', pipeline: 'Funnel', stage: 'Member', stage_entered_at: '2031-10-01T00:00:00Z' }])
    expect(r.data.class_bookings).toEqual([{ starts_at: '2031-11-02T07:00:00Z', class_name: 'HIIT', status: 'BOOKED', attended: null, platform: 'glofox' }])
    for (const t of ['notes', 'activities', 'deals', 'class_bookings']) {
      expect(used(on(t)[0], 'eq', 'contact_id', C1), t).toBe(true)
    }
  })
})

describe('list_pipeline', () => {
  it('list_pipeline groups by stage and marks a capped stage', async () => {
    const deal = (id, stage) => ({
      id, title: id, stage_id: stage, created_at: '2031-10-01T00:00:00Z', stage_entered_at: '2031-10-20T00:00:00Z',
      contacts: { id: `c-${id}`, name: 'N', lead_source: 'web', pipeline_stage_slug: 'new_lead', trial_credits_remaining: 2, recent_bookings: [{ x: 1 }] },
    })
    const { db, on } = makeDb({
      pipelines: { data: [{ id: 'p1', name: 'Funnel', module: null }], error: null },
      pipeline_stages: { data: [
        { id: 's1', name: 'New lead', slug: 'new_lead', position: 1, pipeline_id: 'p1' },
        { id: 's2', name: 'First class', slug: 'first_class', position: 2, pipeline_id: 'p1' },
      ], error: null },
      deals: (q) => (used(q, 'eq', 'stage_id', 's1')
        ? { data: Array.from({ length: 50 }, (_, i) => deal(`d${i}`, 's1')), error: null, count: 70 }
        : { data: [deal('e1', 's2'), deal('e2', 's2')], error: null, count: 2 }),
    })
    const r = await run(listPipeline, {}, 'manager', db)
    expect(r.ok).toBe(true)
    const [s1, s2] = r.data.stages
    expect(s1).toMatchObject({ id: 's1', name: 'New lead', slug: 'new_lead', pipeline: 'Funnel', count: 70, capped: true })
    expect(s1.deals).toHaveLength(50)
    expect(s2).toMatchObject({ id: 's2', count: 2, capped: false })
    expect(s2.deals.map((d) => d.id)).toEqual(['e1', 'e2'])
    expect(JSON.stringify(r.data)).not.toContain('recent_bookings')
    for (const q of on('deals')) {
      expect(used(q, 'eq', 'location_id', DUB)).toBe(true)
      expect(used(q, 'eq', 'status', 'open')).toBe(true)
    }
    expect(used(on('pipeline_stages')[0], 'eq', 'location_id', DUB)).toBe(true)
  })

  it('answers not_found for a pipeline that is not at the studio', async () => {
    const { db, on } = makeDb({ pipelines: { data: [{ id: 'p1', name: 'Funnel', module: null }], error: null } })
    const r = await run(listPipeline, { pipeline_id: '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1f09' }, 'manager', db)
    expect(r).toMatchObject({ ok: false, code: 'not_found' })
    expect(on('deals')).toHaveLength(0)
  })
})

describe('list_tasks', () => {
  it('filters to open tasks at the studio, the caller as assignee and the due window', async () => {
    const { db, on } = makeDb({ activities: { data: [{ id: 't1', subject: 'Call Jo', due_date: '2031-11-01' }], error: null } })
    const r = await run(listTasks, { due: 'today' }, 'manager', db)
    expect(r.ok).toBe(true)
    const q = on('activities')[0]
    expect(used(q, 'eq', 'location_id', DUB)).toBe(true)
    expect(used(q, 'eq', 'done', false)).toBe(true)
    expect(used(q, 'eq', 'kind', 'task')).toBe(true)
    expect(used(q, 'eq', 'assignee_id', ME)).toBe(true)
    expect(used(q, 'eq', 'due_date', '2031-11-01')).toBe(true)

    const all = makeDb()
    await run(listTasks, { assignee: 'all', due: 'week' }, 'manager', all.db)
    const wq = all.on('activities')[0]
    expect(wq.calls.some((c) => c[0] === 'eq' && c[1] === 'assignee_id')).toBe(false)
    expect(used(wq, 'gte', 'due_date', '2031-11-01')).toBe(true)
    expect(used(wq, 'lte', 'due_date', '2031-11-07')).toBe(true)
  })
})

describe('create_contact', () => {
  it('create_contact returns the existing contact on the org email unique violation', async () => {
    const existing = { id: C2, name: 'A B', email: 'A_B@x.ie', location_id: DUB }
    const { db, on } = makeDb({
      contacts: (q) => (q.calls.some((c) => c[0] === 'insert')
        ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "contacts_email_org_unique"' } }
        : { data: existing, error: null }),
    })
    const r = await run(createContact, { name: 'A B', email: 'a_b@x.ie' }, 'manager', db)
    expect(r).toEqual({ ok: true, data: { existing: true, contact: existing } })
    const lookup = on('contacts')[1]
    expect(used(lookup, 'ilike', 'email', 'a\\_b@x.ie')).toBe(true)
    // Only the org's studios where the person holds Contacts (not HATCH).
    expect(argOf(lookup, 'in')).toEqual(['in', 'location_id', [DUB]])
    expect(maybeProvisionLeadInGlofox).not.toHaveBeenCalled()
    expect(triggerSequencesForContactCreated).not.toHaveBeenCalled()

    // Someone the person cannot read: a conflict that names no one.
    const hidden = makeDb({
      contacts: (q) => (q.calls.some((c) => c[0] === 'insert')
        ? { data: null, error: { code: '23505', message: 'duplicate key' } }
        : { data: null, error: null }),
    })
    const r2 = await run(createContact, { name: 'A B', email: 'a_b@x.ie' }, 'manager', hidden.db)
    expect(r2).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('stamps the studio on the new row and runs both hooks; staff are refused', async () => {
    const row = { id: C1, name: 'Jo', email: 'jo@x.ie', location_id: DUB }
    const { db, on } = makeDb({ contacts: { data: row, error: null } })
    const r = await run(createContact, { name: 'Jo', email: 'jo@x.ie' }, 'manager', db)
    expect(r).toEqual({ ok: true, data: { existing: false, contact: row } })
    expect(argOf(on('contacts')[0], 'insert')[1]).toEqual({ name: 'Jo', email: 'jo@x.ie', phone: null, lead_source: 'other', location_id: DUB })
    expect(argOf(on('contacts')[0], 'select')[1]).toBe('id, name, email, location_id')
    expect(maybeProvisionLeadInGlofox).toHaveBeenCalledWith(expect.objectContaining({ db, locationId: DUB, source: 'assistant' }))
    expect(triggerSequencesForContactCreated).toHaveBeenCalledWith(C1)

    const staff = makeDb()
    expect(await run(createContact, { name: 'Jo', email: 'jo@x.ie' }, 'staff', staff.db)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(staff.on('contacts')).toHaveLength(0)
  })
})

describe('create_activity', () => {
  it('create_activity needs manager AND the activities write gate', async () => {
    const tables = {
      contacts: { data: { id: C1, location_id: DUB }, error: null },
      activities: { data: { id: 'act1', subject: 'Call Jo', type: 'call', due_date: '2031-11-03' }, error: null },
    }
    const input = { contact_id: C1, type: 'call', subject: 'Call Jo', due_date: '2031-11-03' }

    // A staff member with both web keys: not a manager.
    const staff = makeDb(tables)
    expect(await run(createActivity, input, 'staff', staff.db, { activities: true, contacts: true })).toMatchObject({ ok: false, code: 'forbidden' })
    // A manager without the web Tasks key.
    const noTasks = makeDb(tables)
    expect(await run(createActivity, input, 'manager', noTasks.db, { activities: false })).toMatchObject({ ok: false, code: 'forbidden' })
    expect([...staff.on('activities'), ...noTasks.on('activities')]).toHaveLength(0)

    const ok = makeDb(tables)
    const r = await run(createActivity, input, 'manager', ok.db)
    expect(r).toEqual({ ok: true, data: { success: true, activity: { id: 'act1', subject: 'Call Jo', type: 'call', due_date: '2031-11-03' } } })
    expect(argOf(ok.on('activities')[0], 'insert')[1]).toMatchObject({
      subject: 'Call Jo', type: 'call', contact_id: C1, location_id: DUB, due_date: '2031-11-03', note: null, done: false,
    })

    // A contact the person cannot read: not_found, nothing written.
    const hidden = makeDb({ ...tables, contacts: { data: { id: C1, location_id: HATCH }, error: null } })
    expect(await run(createActivity, input, 'manager', hidden.db)).toMatchObject({ ok: false, code: 'not_found' })
    expect(hidden.on('activities')).toHaveLength(0)
  })
})
