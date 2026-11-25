// POST /api/instagram/conversations/[id]/snooze (INBOXFOLLOW.2): the send route's
// gates (the inbox key 'ig' rides `whatsapp`, judged at the active studio;
// another studio's thread is 404), the body, and what is written.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const NOW = Date.parse('2026-11-25T12:00:00Z')
const T_A = 'a3000000-0000-4000-8000-00000000000a'
const T_B = 'a3000000-0000-4000-8000-00000000000b'
const T_DONE = 'a3000000-0000-4000-8000-00000000000c'
const iso = (ms) => new Date(NOW + ms).toISOString()
const H = 3600_000
let db
const post = (body, id = T_A) => POST(new Request(`http://localhost/api/instagram/conversations/${id}/snooze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const thread = (id = T_A) => db.tables.instagram_conversations.find((t) => t.id === id)
const inbox = (perms = { whatsapp: true }) => person({ [LOC_A]: { role: 'staff', permissions: perms } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = createFakeDb({ tables: { instagram_conversations: [
    { id: T_A, location_id: LOC_A, resolved_at: null, snoozed_until: null, snoozed_by: null, snooze_note: null, last_message_at: iso(-2 * H), last_message_direction: 'inbound' },
    { id: T_B, location_id: LOC_B, resolved_at: null, snoozed_until: null, snoozed_by: null, snooze_note: null },
    { id: T_DONE, location_id: LOC_A, resolved_at: '2026-11-25T09:00:00Z', snoozed_until: null, snoozed_by: null, snooze_note: null },
  ] } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(inbox())
})
afterEach(() => vi.useRealTimers())

describe('POST /api/instagram/conversations/[id]/snooze', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ until: iso(H) })).status).toBe(401)
  })

  it('403 without the inbox permission, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(inbox({ whatsapp: false }))
    expect((await post({ until: iso(H) })).status).toBe(403)
    expect(thread().snoozed_until).toBeNull()
  })

  it("404 for a thread at a studio the user cannot access, nothing changed", async () => {
    const res = await post({ until: iso(H) }, T_B)
    expect(res.status).toBe(404)
    expect(thread(T_B).snoozed_until).toBeNull()
  })

  it('400 for a time in the past, now, or more than 90 days ahead', async () => {
    for (const ms of [-H, 0, 90 * 24 * H + 1000]) {
      const res = await post({ until: iso(ms) })
      expect(res.status).toBe(400)
      expect((await res.json()).success).toBe(false)
    }
    expect(thread().snoozed_until).toBeNull()
  })

  it('accepts exactly 90 days ahead', async () => {
    expect((await post({ until: iso(90 * 24 * H) })).status).toBe(200)
  })

  it('400 for a note over 140 characters, a malformed time or no body fields', async () => {
    expect((await post({ until: iso(H), note: 'x'.repeat(141) })).status).toBe(400)
    expect((await post({ until: 'tomorrow' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect(thread().snoozed_until).toBeNull()
  })

  it('400 on a completed thread', async () => {
    const res = await post({ until: iso(H) }, T_DONE)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Conversation is completed')
    expect(thread(T_DONE).snoozed_until).toBeNull()
  })

  it("writes the snooze with the caller's id and a trimmed note, and answers the new state", async () => {
    const res = await post({ until: iso(3 * H), note: '  waiting on the quote  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { snoozed_until: iso(3 * H), snooze_note: 'waiting on the quote' } })
    expect(thread()).toMatchObject({ snoozed_until: iso(3 * H), snoozed_by: 'user-1', snooze_note: 'waiting on the quote' })
  })

  it('an empty note is stored as null', async () => {
    await post({ until: iso(H), note: '   ' })
    expect(thread().snooze_note).toBeNull()
  })

  it('until: null clears the snooze and ignores the note', async () => {
    Object.assign(thread(), { snoozed_until: iso(H), snoozed_by: 'user-1', snooze_note: 'old' })
    const res = await post({ until: null, note: 'ignored' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { snoozed_until: null, snooze_note: null } })
    expect(thread()).toMatchObject({ snoozed_until: null, snoozed_by: null, snooze_note: null })
  })

  it('unsnoozing a thread that is not snoozed succeeds', async () => {
    expect((await post({ until: null })).status).toBe(200)
    expect((await post({ until: null }, T_DONE)).status).toBe(200)
  })

  describe('a message that arrived before the click (seen_last_message_at)', () => {
    const NEWER = { message: 'A new message arrived. Check it before snoozing.' }

    it('409 and nothing written when a newer inbound message landed after what the coach saw', async () => {
      const res = await post({ until: iso(H), seen_last_message_at: iso(-3 * H) })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ success: false, error: NEWER.message })
      expect(thread().snoozed_until).toBeNull()
    })

    it('200 when the coach saw the latest inbound message', async () => {
      expect((await post({ until: iso(H), seen_last_message_at: iso(-2 * H) })).status).toBe(200)
      expect(thread().snoozed_until).toBe(iso(H))
    })

    it('200 when the last message is outbound, however new', async () => {
      thread().last_message_direction = 'outbound'
      expect((await post({ until: iso(H), seen_last_message_at: iso(-3 * H) })).status).toBe(200)
    })

    it('200 when the field is omitted, as before', async () => {
      expect((await post({ until: iso(H) })).status).toBe(200)
    })

    it('unsnoozing ignores the field', async () => {
      expect((await post({ until: null, seen_last_message_at: iso(-3 * H) })).status).toBe(200)
    })

    it('400 for a malformed seen_last_message_at', async () => {
      expect((await post({ until: iso(H), seen_last_message_at: 'yesterday' })).status).toBe(400)
    })

    it('409 when a message lands between the read and the write (zero rows from the conditional update)', async () => {
      const realFrom = db.from.bind(db)
      db.from = (t) => {
        const b = realFrom(t)
        const update = b.update.bind(b)
        b.update = (...a) => { thread().last_message_at = iso(-1000); return update(...a) }
        return b
      }
      const res = await post({ until: iso(H), seen_last_message_at: iso(-2 * H) })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe(NEWER.message)
      expect(thread().snoozed_until).toBeNull()
    })

    it('a thread with no last message is snoozed with the null guard', async () => {
      Object.assign(thread(), { last_message_at: null, last_message_direction: null })
      expect((await post({ until: iso(H), seen_last_message_at: iso(-3 * H) })).status).toBe(200)
    })
  })

  it('a failed update is a 500 with a fixed message, never success', async () => {
    db.errors.instagram_conversations = { update: { code: '57014', message: 'statement timeout on instagram_conversations' } }
    const res = await post({ until: iso(H) })
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.success).toBe(false)
    expect(j.error).not.toMatch(/instagram_conversations/)
    expect(thread().snoozed_until).toBeNull()
  })
})

describe('INBOXPERM.1 — the inbox key is judged at the thread\'s studio, web OR phone', () => {
  const at = (a, b, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: a }, [LOC_B]: { role: 'staff', permissions: b } }, active)

  it('the phone key alone is enough (the phone calls this route)', async () => {
    getCurrentUser.mockResolvedValue(inbox({ whatsapp: false, mobile: { whatsapp: true } }))
    expect((await post({ until: iso(H) })).status).toBe(200)
  })

  it('403 at a member studio where the key is off (key held only at the active studio): only the gate select ran', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: true }, { whatsapp: false }))
    expect((await post({ until: iso(H) }, T_B)).status).toBe(403)
    expect(thread(T_B).snoozed_until).toBeNull()
    expect(db.calls.every((c) => c.table === 'instagram_conversations' && c.op === 'select')).toBe(true)
  })

  it('passes at the thread\'s studio when the key is held there but not at the active studio', async () => {
    getCurrentUser.mockResolvedValue(at({ whatsapp: false }, { whatsapp: true }))
    expect((await post({ until: iso(H) }, T_B)).status).toBe(200)
    expect(thread(T_B).snoozed_until).not.toBeNull()
  })
})
