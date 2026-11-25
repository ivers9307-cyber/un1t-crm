import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))

const { readHandledByName, firstNameOf } = await import('./handled-by-name.js')

const CONV = 'a1000000-0000-4000-8000-000000000001'
const LOC = 'b1000000-0000-4000-8000-000000000001'
const ANNA = 'c1000000-0000-4000-8000-000000000001'
const BEN = 'c1000000-0000-4000-8000-000000000002'
const GONE = 'c1000000-0000-4000-8000-000000000003'

const profile = (id, full_name, extra = {}) => ({ id, full_name, email: `${full_name}@x.test`, role: 'staff', ...extra })
const person = (extra = {}) => ({ id: CONV, location_id: LOC, staff_owned_since: '2026-11-25T10:00:00Z', agent_active: false, assigned_to: null, ...extra })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    profiles: [profile(ANNA, 'Anna Murphy'), profile(BEN, 'Ben Carter'), profile(GONE, 'Deleted Person', { deleted_at: '2026-11-01T00:00:00Z' })],
    whatsapp_messages: [],
  } })
})

describe('firstNameOf', () => {
  it('takes the first word, and null for nothing', () => {
    expect(firstNameOf('  Anna Murphy ')).toBe('Anna')
    expect(firstNameOf('')).toBeNull()
    expect(firstNameOf(null)).toBeNull()
  })
})

describe('readHandledByName', () => {
  it('uses the assignee when there is one, without reading messages', async () => {
    expect(await readHandledByName(db, 'wa', person({ assigned_to: ANNA }))).toBe('Anna')
    expect(db.calls.map((c) => c.table)).not.toContain('whatsapp_messages')
  })

  it('falls back to the sender of the newest staff message on WhatsApp', async () => {
    db.tables.whatsapp_messages = [
      { id: 'd1000000-0000-4000-8000-000000000001', conversation_id: CONV, direction: 'outbound', sent_by: ANNA, created_at: '2026-11-25T09:00:00Z' },
      { id: 'd1000000-0000-4000-8000-000000000002', conversation_id: CONV, direction: 'outbound', sent_by: BEN, created_at: '2026-11-25T10:00:00Z' },
      { id: 'd1000000-0000-4000-8000-000000000003', conversation_id: CONV, direction: 'outbound', sent_by: null, created_at: '2026-11-25T11:00:00Z' },
    ]
    expect(await readHandledByName(db, 'wa', person())).toBe('Ben')
  })

  it('Instagram has no per-message sender: no assignee means null, and no message read', async () => {
    expect(await readHandledByName(db, 'ig', person({ agent_active: false }))).toBeNull()
    expect(db.calls.map((c) => c.table)).toEqual([])
  })

  it('reads nothing unless a person has the thread', async () => {
    expect(await readHandledByName(db, 'wa', { id: CONV, assigned_to: ANNA })).toBeNull()
    expect(db.calls).toEqual([])
  })

  it('a tombstoned or missing profile gives null', async () => {
    expect(await readHandledByName(db, 'wa', person({ assigned_to: GONE }))).toBeNull()
    expect(await readHandledByName(db, 'wa', person({ assigned_to: 'c1000000-0000-4000-8000-0000000000ff' }))).toBeNull()
  })

  it('reads only id and full_name from profiles', async () => {
    const selects = []
    const realFrom = db.from.bind(db)
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'profiles') return b
      const sel = b.select.bind(b)
      b.select = (cols, ...rest) => { selects.push(cols); return sel(cols, ...rest) }
      return b
    }
    await readHandledByName(db, 'wa', person({ assigned_to: ANNA }))
    expect(selects).toEqual(['id, full_name'])
  })

  it('a failed profile read gives null', async () => {
    db.errors.profiles = { select: { message: 'boom' } }
    expect(await readHandledByName(db, 'wa', person({ assigned_to: ANNA }))).toBeNull()
  })

  it('a failed message read gives null', async () => {
    db.errors.whatsapp_messages = { select: { message: 'boom' } }
    expect(await readHandledByName(db, 'wa', person())).toBeNull()
  })

  it('a thrown read gives null', async () => {
    const throwing = { from() { throw new Error('down') } }
    expect(await readHandledByName(throwing, 'wa', person({ assigned_to: ANNA }))).toBeNull()
  })
})
