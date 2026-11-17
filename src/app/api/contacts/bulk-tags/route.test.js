// CONTACTTAGS.1 — POST /api/contacts/bulk-tags: gate, studio scope, the
// compare-and-set write, and honest counts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contact-studio-link', () => ({ contactIdsLinkedToStudio: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForTagsAdded: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { contactIdsLinkedToStudio } from '@/lib/contact-studio-link'
import { triggerSequencesForTagsAdded } from '@/lib/sequences'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'
const C1 = 'c0000000-0000-4000-8000-000000000001'
const C2 = 'c0000000-0000-4000-8000-000000000002'
const C3 = 'c0000000-0000-4000-8000-000000000003'

const manager = (perms = {}) => ({
  id: 'u1',
  role: 'manager',
  activeLocation: { id: LOC },
  locations: [{ id: LOC, role: 'manager' }],
  rolesByLocation: { [LOC]: 'manager' },
  assignmentsByLocation: { [LOC]: { role: 'manager', permissions: perms } },
})

// In-memory contacts with just enough of the PostgREST builder for the route.
function fakeDb(contacts, { writeError = null, sequences = [], bumpOnFirstWrite = null } = {}) {
  const store = new Map(contacts.map((c) => [c.id, { ...c }]))
  const writes = []
  let firstWrite = true
  const arrLit = (a) => `{${(a || []).map((t) => `"${t}"`).join(',')}}`
  function contactsTable() {
    return {
      select: () => ({
        in: async (_col, ids) => ({ data: ids.map((id) => store.get(id)).filter(Boolean).map((r) => ({ ...r })), error: null }),
        eq: (_col, id) => ({ maybeSingle: async () => ({ data: store.has(id) ? { ...store.get(id) } : null, error: null }) }),
      }),
      update: (patch) => {
        const conds = {}
        const b = {
          eq: (_c, v) => { conds.id = v; return b },
          is: (_c, v) => { conds.isNull = v === null; return b },
          filter: (_c, _op, v) => { conds.literal = v; return b },
          select: async () => {
            writes.push({ id: conds.id, patch })
            if (writeError) return { data: null, error: writeError }
            if (bumpOnFirstWrite && firstWrite) {
              firstWrite = false
              const r = store.get(bumpOnFirstWrite.id)
              r.tags = bumpOnFirstWrite.tags
            }
            const row = store.get(conds.id)
            const current = row?.tags
            const matches = row && (conds.isNull ? current == null : arrLit(current) === conds.literal)
            if (!matches) return { data: [], error: null }
            row.tags = patch.tags
            return { data: [{ id: row.id }], error: null }
          },
        }
        return b
      },
    }
  }
  return {
    store,
    writes,
    from: vi.fn((t) => {
      if (t === 'contacts') return contactsTable()
      if (t === 'email_sequences') {
        const b = { select: () => b, in: () => b, eq: () => b, then: (res) => res({ data: sequences, error: null }) }
        return b
      }
      throw new Error(`unexpected table ${t}`)
    }),
  }
}

const req = (body) => new Request('http://localhost/api/contacts/bulk-tags', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager())
  contactIdsLinkedToStudio.mockImplementation(async (_db, { contactIds }) => ({ ok: true, ids: contactIds.filter((id) => id !== C3), joined: [] }))
})

describe('POST /api/contacts/bulk-tags — gate', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))).status).toBe(401)
  })
  it('403 for a manager without Contacts at the active studio, nothing read', async () => {
    getCurrentUser.mockResolvedValue(manager({ contacts: false }))
    const db = fakeDb([])
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))).status).toBe(403)
    expect(db.from).not.toHaveBeenCalled()
  })
  it('403 for plain staff', async () => {
    getCurrentUser.mockResolvedValue({ ...manager(), role: 'staff', locations: [{ id: LOC, role: 'staff' }], rolesByLocation: { [LOC]: 'staff' }, assignmentsByLocation: { [LOC]: { role: 'staff', permissions: { contacts: true } } } })
    createServerClient.mockReturnValue(fakeDb([]))
    expect((await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))).status).toBe(403)
  })
  it('400 on more than 500 ids or a bad action', async () => {
    createServerClient.mockReturnValue(fakeDb([]))
    const many = Array.from({ length: 501 }, (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect((await POST(req({ contact_ids: many, tag: 'vip', action: 'add' }))).status).toBe(400)
    expect((await POST(req({ contact_ids: [C1], tag: 'vip', action: 'toggle' }))).status).toBe(400)
  })
})

describe('POST /api/contacts/bulk-tags — scope and writes', () => {
  it('a contact the studio cannot act on is skipped and never written', async () => {
    const db = fakeDb([
      { id: C1, location_id: LOC, tags: [] },
      { id: C3, location_id: OTHER, tags: [] },
    ])
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ contact_ids: [C1, C3], tag: 'vip', action: 'add' }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toEqual({ requested: 2, updated: 1, unchanged: 0, skipped: 1, failed: 0 })
    expect(db.writes.map((w) => w.id)).toEqual([C1])
    expect(db.store.get(C3).tags).toEqual([])
    expect(contactIdsLinkedToStudio).toHaveBeenCalledWith(db, { locationId: LOC, contactIds: [C1, C3] })
  })

  it('add is idempotent: a contact that has the tag is unchanged and not written', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: ['vip'] }, { id: C2, location_id: LOC, tags: null }])
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req({ contact_ids: [C1, C2], tag: ' vip ', action: 'add' }))).json()
    expect(data).toMatchObject({ updated: 1, unchanged: 1, failed: 0 })
    expect(db.writes.map((w) => w.id)).toEqual([C2])
    expect(db.store.get(C2).tags).toEqual(['vip'])
  })

  it('remove of an absent tag is a no-op', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: ['other'] }])
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req({ contact_ids: [C1], tag: 'vip', action: 'remove' }))).json()
    expect(data).toMatchObject({ updated: 0, unchanged: 1 })
    expect(db.writes).toEqual([])
  })

  it('remove takes the tag off and fires no sequence', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: ['vip', 'other'] }])
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req({ contact_ids: [C1], tag: 'vip', action: 'remove' }))).json()
    expect(data.updated).toBe(1)
    expect(db.store.get(C1).tags).toEqual(['other'])
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })

  it('a failed write is counted as failed, not as updated', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: [] }], { writeError: { code: '57014', message: 'timeout' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ updated: 0, failed: 1 })
  })

  it('a concurrent edit is not clobbered: re-read and merged', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: ['a'] }], { bumpOnFirstWrite: { id: C1, tags: ['a', 'b'] } })
    createServerClient.mockReturnValue(db)
    const { data } = await (await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))).json()
    expect(data).toMatchObject({ updated: 1, failed: 0 })
    expect(db.store.get(C1).tags).toEqual(['a', 'b', 'vip'])
    expect(db.writes).toHaveLength(2)
  })

  it('a failed studio check writes nothing and says so', async () => {
    contactIdsLinkedToStudio.mockResolvedValue({ ok: false, reason: 'contacts_unreadable' })
    const db = fakeDb([{ id: C1, location_id: LOC, tags: [] }])
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))).status).toBe(503)
    expect(db.writes).toEqual([])
  })

  it('fires tag_added sequences only for contacts that gained the tag, and only when one listens', async () => {
    const db = fakeDb(
      [{ id: C1, location_id: LOC, tags: [] }, { id: C2, location_id: LOC, tags: ['vip'] }],
      { sequences: [{ id: 's1', location_id: LOC, trigger_config: { tag: 'vip' } }] },
    )
    createServerClient.mockReturnValue(db)
    await POST(req({ contact_ids: [C1, C2], tag: 'vip', action: 'add' }))
    expect(triggerSequencesForTagsAdded).toHaveBeenCalledTimes(1)
    expect(triggerSequencesForTagsAdded).toHaveBeenCalledWith(C1, ['vip'])
  })

  it('no listening sequence: no per-contact trigger calls', async () => {
    const db = fakeDb([{ id: C1, location_id: LOC, tags: [] }], { sequences: [{ id: 's1', location_id: LOC, trigger_config: { tag: 'other' } }] })
    createServerClient.mockReturnValue(db)
    await POST(req({ contact_ids: [C1], tag: 'vip', action: 'add' }))
    expect(triggerSequencesForTagsAdded).not.toHaveBeenCalled()
  })
})
