// INBOXFOLLOW.1 — GET /api/whatsapp/conversations returns every thread the
// queues need, not just the latest 50, plus the studio's follow-up config.
// Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/inbox-search-server', async (importOriginal) => ({
  ...(await importOriginal()),
  searchInboxContactIds: vi.fn(async () => []),
  searchWhatsAppMessageHits: vi.fn(async () => ({ hits: [], failed: false })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')

const caller = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
const get = (qs = '') => GET(new Request(`http://localhost/api/whatsapp/conversations${qs}`))
const id = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const day = (n) => new Date(Date.UTC(2026, 10, 25) - n * 3600_000).toISOString()

// 60 threads: 55 are waiting on a coach (inbound, the oldest well outside the
// newest 50), 5 are answered.
function sixtyThreads() {
  const rows = []
  for (let n = 1; n <= 55; n++) {
    rows.push({ id: id(n), location_id: LOC_A, last_message_at: day(n + 10), last_message_direction: 'inbound', customer_waiting_since: day(n + 10) })
  }
  for (let n = 56; n <= 60; n++) {
    rows.push({ id: id(n), location_id: LOC_A, last_message_at: day(n - 55), last_message_direction: 'outbound' })
  }
  return rows
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(caller)
  db = createFakeDb({ tables: { whatsapp_conversations: sixtyThreads(), contacts: [], agent_membership_requests: [], locations: [] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/whatsapp/conversations — the queues see every waiting thread', () => {
  it('returns all 55 waiting threads of a 60-thread studio, not the latest 50', async () => {
    const res = await get(`?location_id=${LOC_A}`)
    const body = await res.json()
    expect(body.success).toBe(true)
    const waiting = body.conversations.filter((c) => c.last_message_direction === 'inbound')
    expect(waiting).toHaveLength(55)
    expect(body.conversations).toHaveLength(60)
    // Newest message first, as before.
    const times = body.conversations.map((c) => c.last_message_at)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('does not return a resolved thread through the active set', async () => {
    db.tables.whatsapp_conversations.push({ id: id(99), location_id: LOC_A, last_message_at: day(900), last_message_direction: 'inbound', resolved_at: day(800) })
    const body = await (await get(`?location_id=${LOC_A}`)).json()
    expect(body.conversations.map((c) => c.id)).not.toContain(id(99))
  })

  it('includes an older thread that Mia asked a person for, or that is snoozed or waited on', async () => {
    db.tables.whatsapp_conversations.length = 0
    for (let n = 1; n <= 50; n++) db.tables.whatsapp_conversations.push({ id: id(n), location_id: LOC_A, last_message_at: day(n), last_message_direction: 'outbound' })
    db.tables.whatsapp_conversations.push(
      { id: id(70), location_id: LOC_A, last_message_at: day(500), last_message_direction: 'outbound', handoff_requested_at: day(501) },
      { id: id(71), location_id: LOC_A, last_message_at: day(501), last_message_direction: 'outbound', staff_waiting_since: day(502) },
      { id: id(72), location_id: LOC_A, last_message_at: day(502), last_message_direction: 'outbound', snoozed_until: day(-100) },
      { id: id(73), location_id: LOC_A, last_message_at: day(503), last_message_direction: 'outbound' },
    )
    const ids = (await (await get(`?location_id=${LOC_A}`)).json()).conversations.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([id(70), id(71), id(72)]))
    expect(ids).not.toContain(id(73))
  })

  it('keeps the oldest waiting threads when 400 are waiting, and logs the truncation', async () => {
    db.tables.whatsapp_conversations.length = 0
    for (let n = 1; n <= 400; n++) db.tables.whatsapp_conversations.push({ id: id(n), location_id: LOC_A, last_message_at: day(n), last_message_direction: 'inbound' })
    const body = await (await get(`?location_id=${LOC_A}`)).json()
    const ids = body.conversations.map((c) => c.id)
    expect(ids).toContain(id(400)) // the longest-waiting thread
    expect(ids).toContain(id(1)) // the newest, via the latest-50 read
    expect(ids).not.toContain(id(75)) // newer than the 300 oldest, older than the latest 50: the cut
    expect(logError).toHaveBeenCalledWith('wa-inbox', expect.stringMatching(/limit/), expect.anything())
  })

  it('keeps search as it was: the latest 50 matches, no extra read', async () => {
    const res = await get(`?location_id=${LOC_A}&q=ab`)
    const body = await res.json()
    expect(body.conversations.length).toBeLessThanOrEqual(50)
    const reads = db.calls.filter((c) => c.table === 'whatsapp_conversations')
    expect(reads).toHaveLength(1)
  })

  it('serves the latest 50 and logs when the active set read fails', async () => {
    const realFrom = db.from.bind(db)
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'whatsapp_conversations') return b
      let active = false
      const is = b.is.bind(b)
      b.is = (...a) => { active = true; return is(...a) }
      const then = b.then.bind(b)
      b.then = (res, rej) => (active ? Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res, rej) : then(res, rej))
      return b
    }
    const res = await get(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    expect((await res.json()).conversations).toHaveLength(50)
    expect(logError).toHaveBeenCalledWith('wa-inbox', expect.stringMatching(/active set/), expect.anything())
  })
})

describe('GET /api/whatsapp/conversations — follow-up config', () => {
  it('returns the studio config for one studio', async () => {
    db.tables.locations.push({ id: LOC_A, name: 'Studio A', timezone: 'Europe/Dublin', settings: { customer_agent: { enabled: true, followups: { staff_threads: { quiet_after_hours: 24, nudge_enabled: true } } } } })
    const body = await (await get(`?location_id=${LOC_A}`)).json()
    expect(body.followup).toEqual({ quietHours: 24, nudgeEnabled: true })
  })
  it('a studio whose agent is off has no nudge, so no grace day', async () => {
    db.tables.locations.push({ id: LOC_A, name: 'Studio A', timezone: 'Europe/Dublin', settings: { customer_agent: { enabled: false, followups: { staff_threads: { quiet_after_hours: 24, nudge_enabled: true } } } } })
    const body = await (await get(`?location_id=${LOC_A}`)).json()
    expect(body.followup).toEqual({ quietHours: 24, nudgeEnabled: false })
  })

  it('falls back to the defaults when the studio has no config, or none is named', async () => {
    expect((await (await get(`?location_id=${LOC_A}`)).json()).followup).toEqual({ quietHours: 48, nudgeEnabled: false })
    expect((await (await get()).json()).followup).toEqual({ quietHours: 48, nudgeEnabled: false })
  })

  it('403 for a studio that is not the caller’s, and nothing is read', async () => {
    const res = await get(`?location_id=${LOC_B}`)
    expect(res.status).toBe(403)
  })
})

describe('INBOXPERM.1 — GET /api/whatsapp/conversations judges the inbox key (web or phone) at the requested studio', () => {
  const two = (a, b, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: a }, [LOC_B]: { role: 'staff', permissions: b } }, active)
  const seed = () => db.tables.whatsapp_conversations.push({ id: id(900), location_id: LOC_B, last_message_at: day(1), last_message_direction: 'inbound' })

  it('403 for ?location_id at a member studio without the key (key held at the active studio only), nothing read', async () => {
    getCurrentUser.mockResolvedValue(two({ whatsapp: true }, { whatsapp: false }))
    seed()
    const before = db.calls.length
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(403)
    expect(db.calls.length).toBe(before)
  })

  it('the key at the requested studio is enough when the active studio is another one', async () => {
    getCurrentUser.mockResolvedValue(two({ whatsapp: false }, { whatsapp: true }))
    seed()
    const res = await get(`?location_id=${LOC_B}`)
    expect(res.status).toBe(200)
    expect((await res.json()).conversations.map((c) => c.id)).toEqual([id(900)])
  })

  it('without ?location_id the list holds only the studios where the caller has the key', async () => {
    getCurrentUser.mockResolvedValue(two({ whatsapp: true }, { whatsapp: false }))
    seed()
    const body = await (await get()).json()
    expect(body.conversations.length).toBeGreaterThan(0)
    expect(new Set(body.conversations.map((c) => c.location_id))).toEqual(new Set([LOC_A]))
  })

  it('the phone key alone at the studio is allowed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false, mobile: { whatsapp: true } } } }, LOC_A))
    expect((await get(`?location_id=${LOC_A}`)).status).toBe(200)
  })

  it('403 when the key is held at no studio at all', async () => {
    getCurrentUser.mockResolvedValue(two({ whatsapp: false }, { whatsapp: false }))
    expect((await get()).status).toBe(403)
  })
})

describe('GET /api/whatsapp/conversations — approval badges are best effort', () => {
  it('a failed badge read is logged and the list still loads', async () => {
    db.errors.agent_membership_requests = { select: { message: 'statement timeout' } }
    const res = await get(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversations).toHaveLength(60)
    expect(body.conversations.every((c) => c.pending_approval === false)).toBe(true)
    expect(logError).toHaveBeenCalledWith('wa-inbox', expect.stringContaining('approval badges'), expect.anything())
  })
})
