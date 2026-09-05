// MAIL-SPAM.1 — the quarantine, as the list surfaces see it.
//
// THE PROPERTY UNDER TEST: a ticket flagged `is_spam` appears in EXACTLY ONE
// place — the `spam` view — and nowhere else. Not in Inbox, not in Needs
// reply, not in Sent or Archived, not in the needs-reply badge on the list, the
// nav-badge count route, the digest's tile count or the digest's sections,
// and not in a search result unless the operator is ON the spam view.
//
// Every fixture row carries `is_spam: false` (the NOT NULL DEFAULT false the
// column has in prod), and the spam rows below flip only that flag — so if
// the scope is ever dropped, the same open+inbound row that the inbox lists
// today shows up in these assertions and they fail.
//
// Mobile is untouched by construction: an old bundle never sends `view=spam`,
// so every request it can make lands on the `is_spam=false` side.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})
vi.mock('./_search', () => ({
  searchTicketIds: vi.fn(),
  SEARCH_SCAN_LIMIT: 1000,
}))

import { GET as LIST, MAIL_VIEWS } from './route'
import { GET as COUNT } from './count/route'
import { GET as DIGEST } from './digest/route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { searchTicketIds } from './_search'
import { makeDb } from '../tickets/_test-db'
import { LOC_A, T_STUDIO, T_ACCOUNTS, OWNER, mailState } from './_test-fixtures'

const SPAM = {
  ...T_STUDIO,
  id: 'aaaaaaa9-0000-4000-8000-000000000009',
  subject: 'You have won',
  requester_email: 'lottery@example.net',
  is_spam: true,
  spam_score: 9.4,
  spam_flagged_at: '2026-08-06T09:30:00Z',
  status: 'open',
  last_message_direction: 'inbound',
  last_message_at: '2026-08-06T09:30:00Z',
}
// The SAME shape as a live inbox row, spam flag aside.
const LIVE = { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' }
const LIVE_ACCOUNTS = { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' }

const ids = (rows) => rows.map(r => r.id)

async function list(query = `?location_id=${LOC_A}`) {
  const res = await LIST(new Request(`http://x/api/email/mail${query}`))
  return { res, body: await res.json() }
}
async function count(query = '') {
  const res = await COUNT(new Request(`http://x/api/email/mail/count${query}`))
  return { res, body: await res.json() }
}
async function digest(query = '') {
  const res = await DIGEST(new Request(`http://x/api/email/mail/digest${query}`))
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue({ ...OWNER, activeLocation: { id: LOC_A } })
  searchTicketIds.mockResolvedValue({ ok: true, skipped: true, ids: null, partial: false })
  setupDb(mailState({ tickets: [{ ...LIVE }, { ...LIVE_ACCOUNTS }, { ...SPAM }] }))
})

describe('the spam view is a first-class view', () => {
  it('is in the wire vocabulary', () => {
    expect(MAIL_VIEWS).toContain('spam')
  })

  it('view=spam lists ONLY quarantined conversations', async () => {
    const { res, body } = await list(`?location_id=${LOC_A}&view=spam`)
    expect(res.status).toBe(200)
    expect(ids(body.data.conversations)).toEqual([SPAM.id])
    expect(body.data.conversations[0].is_spam).toBe(true)
    expect(body.data.conversations[0].spam_score).toBe(9.4)
  })

  it('a quarantined conversation is NOT needs-reply, even though it is open with an inbound last message', async () => {
    const { body } = await list(`?location_id=${LOC_A}&view=spam`)
    expect(body.data.conversations[0].needs_reply).toBe(false)
  })
})

describe('quarantined rows are absent from every other view', () => {
  it('inbox (the default, and what every old mobile bundle asks for)', async () => {
    const { body } = await list()
    expect(ids(body.data.conversations)).not.toContain(SPAM.id)
    expect(ids(body.data.conversations)).toEqual(expect.arrayContaining([LIVE.id, LIVE_ACCOUNTS.id]))
    const explicit = await list(`?location_id=${LOC_A}&view=inbox`)
    expect(ids(explicit.body.data.conversations)).not.toContain(SPAM.id)
  })

  it('needs_reply', async () => {
    const { body } = await list(`?location_id=${LOC_A}&view=needs_reply`)
    expect(ids(body.data.conversations)).not.toContain(SPAM.id)
    expect(ids(body.data.conversations)).toContain(LIVE.id)
  })

  it('sent and archived', async () => {
    setupDb(mailState({
      tickets: [
        { ...SPAM, has_inbound: false },
        { ...SPAM, id: 'aaaaaaa8-0000-4000-8000-000000000008', status: 'closed' },
      ],
    }))
    expect(ids((await list(`?location_id=${LOC_A}&view=sent`)).body.data.conversations)).toEqual([])
    expect(ids((await list(`?location_id=${LOC_A}&view=archived`)).body.data.conversations)).toEqual([])
    // …and both still show on the spam view, whatever their status.
    expect(ids((await list(`?location_id=${LOC_A}&view=spam`)).body.data.conversations)).toHaveLength(2)
  })

  it('the list badge (needs_reply_count) does not count it', async () => {
    const { body } = await list()
    // LIVE + LIVE_ACCOUNTS are both open+inbound; SPAM would make it 3.
    expect(body.data.needs_reply_count).toBe(2)
  })

  it('search excludes it unless the operator is on the spam view', async () => {
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, ids: [SPAM.id, LIVE.id], partial: false })
    const inbox = await list(`?location_id=${LOC_A}&q=won`)
    expect(ids(inbox.body.data.conversations)).toEqual([LIVE.id])
    const spam = await list(`?location_id=${LOC_A}&view=spam&q=won`)
    expect(ids(spam.body.data.conversations)).toEqual([SPAM.id])
  })
})

describe('the nav badge (GET /api/email/mail/count) never counts quarantined mail', () => {
  it('at the active location', async () => {
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(2)
  })

  it('under ?scope=all', async () => {
    const { body } = await count('?scope=all')
    expect(body.data.count).toBe(2)
  })
})

describe('the digest (GET /api/email/mail/digest) never lists or counts quarantined mail', () => {
  it('tile count and inbox sections exclude it', async () => {
    const { res, body } = await digest()
    expect(res.status).toBe(200)
    const loc = body.data.locations.find(l => l.location_id === LOC_A)
    expect(loc.needs_reply_count).toBe(2)
    expect(ids(loc.conversations)).not.toContain(SPAM.id)
    expect(loc.view_total).toBe(2)
  })

  it('view=spam sections list it, and the tile count stays needs-reply', async () => {
    const { body } = await digest('?view=spam')
    const loc = body.data.locations.find(l => l.location_id === LOC_A)
    expect(ids(loc.conversations)).toEqual([SPAM.id])
    expect(loc.view_total).toBe(1)
    expect(loc.needs_reply_count).toBe(2)
  })
})
