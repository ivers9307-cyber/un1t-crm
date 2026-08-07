// EMAIL-ATTACH.1 — the operator's storage view and the release valve.
//
// TWO PROPERTIES THIS FILE EXISTS FOR
//
// 1. A MANAGER MUST NOT REACH THIS SURFACE. A manager holds `email_inbox` and
//    can already read the inbox, so the tempting gate is that key — and it is
//    wrong twice over here: prune DESTROYS a member's attachments, and the
//    numbers describe accounts a manager may have no grant for. Same gate as
//    the mailbox admin routes, master-or-owner-at-this-location, and every
//    refusal test asserts NO WRITE HAPPENED rather than just a status code.
//
// 2. PRUNING MOVES THE COUNTER. A delete path that removes rows and bytes but
//    leaves bytes_used high converts a full mailbox into a permanently full
//    one — every future attachment refused for space that was freed months ago,
//    with nothing on any screen to explain it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { GET, POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { makeDb, objectKeys, usageFor, writesTo } from '@/app/api/email/tickets/_test-db'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, adminState,
} from '../mailboxes/_test-fixtures'
import { EMAIL_MAILBOX_QUOTA_BYTES } from '@/lib/email-attachment-quota'

const props = { params: { id: LOC_A } }
const url = `http://x/api/locations/${LOC_A}/email/storage`

const getReq = () => new Request(url)
const postReq = (body) => new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const OLD = '2020-01-01T00:00:00Z'

/**
 * Two accounts, one nearly full and one nearly empty, plus a closed ticket
 * carrying two prunable attachments on the full one.
 */
function storageState(extra = {}) {
  const s = adminState({
    tickets: [{ id: 'tk-1', location_id: LOC_A, mailbox_id: MB_ACCOUNTS.id, status: 'closed' }],
    messages: [{ id: 'msg-1', ticket_id: 'tk-1', location_id: LOC_A }],
    attachments: [0, 1].map(i => ({
      id: `att-${i}`, message_id: 'msg-1', location_id: LOC_A, mailbox_id: MB_ACCOUNTS.id,
      attachment_index: i, filename: `f${i}.pdf`, mime_type: 'application/pdf',
      size_bytes: 1_000_000, storage_path: `${LOC_A}/msg-1/${i}.pdf`, skipped_reason: null,
      created_at: OLD,
    })),
    storageUsage: [
      {
        id: 'u-accounts', location_id: LOC_A, mailbox_id: MB_ACCOUNTS.id,
        bytes_used: EMAIL_MAILBOX_QUOTA_BYTES, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
      },
      {
        id: 'u-studio', location_id: LOC_A, mailbox_id: MB_STUDIO.id,
        bytes_used: 1024, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
      },
    ],
    ...extra,
  })
  s.objects = new Map([0, 1].map(i => [`email-attachments/${LOC_A}/msg-1/${i}.pdf`, { bytes: 'x' }]))
  return s
}

let db
let errSpy
beforeEach(() => {
  vi.clearAllMocks()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  getCurrentUser.mockResolvedValue(OWNER_A)
  db = makeDb(storageState())
  createServerClient.mockImplementation(() => db)
})
afterEach(() => errSpy.mockRestore())

const read = async (p = props) => {
  const res = await GET(getReq(), p)
  return { res, body: await res.json() }
}
const act = async (body, p = props) => {
  const res = await POST(postReq(body), p)
  return { res, body: await res.json() }
}

describe('the gate', () => {
  it('401s when unauthenticated, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await read()).res.status).toBe(401)
    expect((await act({ action: 'prune', mailbox_id: MB_ACCOUNTS.id })).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES a manager at this location — and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await read()).res.status).toBe(403)
    const pruned = await act({ action: 'prune', mailbox_id: MB_ACCOUNTS.id })
    expect(pruned.res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
    expect(objectKeys(db)).toHaveLength(2)
  })

  it('REFUSES an owner of a different studio — and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    expect((await read()).res.status).toBe(403)
    expect((await act({ action: 'prune' })).res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  it('allows a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await read()).res.status).toBe(200)
  })
})

describe('GET — the usage view', () => {
  it('reports every account, with its level, sorted fullest first', async () => {
    const { res, body } = await read()
    expect(res.status).toBe(200)

    const rows = body.data.mailboxes
    expect(rows.map(r => r.mailbox_id)).toEqual([MB_ACCOUNTS.id, MB_STUDIO.id])
    expect(rows[0]).toMatchObject({
      label: MB_ACCOUNTS.label, level: 'full', full: true, percent: 100, remaining: 0,
    })
    expect(rows[1]).toMatchObject({ label: MB_STUDIO.label, level: 'ok', full: false })
    // Another studio's account is never in this list.
    expect(rows.map(r => r.mailbox_id)).not.toContain(MB_OTHER_LOCATION.id)
  })

  it('shows an account that has never received a file as 0 of 5 GB, not as missing', async () => {
    db = makeDb(storageState({ storageUsage: [] }))
    createServerClient.mockImplementation(() => db)
    const { body } = await read()
    expect(body.data.mailboxes).toHaveLength(2)
    for (const row of body.data.mailboxes) {
      expect(row.bytes_used).toBe(0)
      expect(row.quota_bytes).toBe(EMAIL_MAILBOX_QUOTA_BYTES)
      expect(row.level).toBe('ok')
    }
  })

  it('hides the unfiled bucket when there is nothing in it', async () => {
    expect((await read()).body.data.unfiled).toBeNull()
  })

  it('shows the unfiled bucket when a deleted mailbox left bytes behind', async () => {
    const s = storageState()
    s.storageUsage.push({
      id: 'u-unfiled', location_id: LOC_A, mailbox_id: null,
      bytes_used: 900, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })
    db = makeDb(s)
    createServerClient.mockImplementation(() => db)

    const { body } = await read()
    expect(body.data.unfiled).toMatchObject({ mailbox_id: null, bytes_used: 900 })
    // …and it is NOT double-counted as a mailbox row.
    expect(body.data.mailboxes.map(m => m.mailbox_id)).not.toContain(null)
  })

  it('FAILS LOUDLY rather than reporting an empty, reassuring zero', async () => {
    db = makeDb(storageState({ errors: { email_storage_usage: { message: 'boom' } } }))
    createServerClient.mockImplementation(() => db)
    expect((await read()).res.status).toBe(500)
  })
})

describe('POST prune — the release valve', () => {
  it('frees the bytes AND decrements the counter', async () => {
    const { res, body } = await act({
      action: 'prune', mailbox_id: MB_ACCOUNTS.id, older_than_days: 30,
    })

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ pruned: 2, bytes_freed: 2_000_000, remaining: 0 })

    // The counter moved — this is the whole point of the feature.
    expect(usageFor(db, LOC_A, MB_ACCOUNTS.id).bytes_used)
      .toBe(EMAIL_MAILBOX_QUOTA_BYTES - 2_000_000)
    expect(objectKeys(db)).toEqual([])

    // The mailbox is no longer full, which the very next GET must show.
    const after = await read()
    expect(after.body.data.mailboxes[0].full).toBe(false)
  })

  it('keeps the record, so a member can be asked for a resend', async () => {
    await act({ action: 'prune', mailbox_id: MB_ACCOUNTS.id, older_than_days: 30 })
    for (const row of db._state.attachments) {
      expect(row.storage_path).toBeNull()
      expect(row.skipped_reason).toBe('pruned')
      expect(row.filename).toMatch(/\.pdf$/)
    }
  })

  it('audits the destruction', async () => {
    await act({ action: 'prune', mailbox_id: MB_ACCOUNTS.id, older_than_days: 30 })
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'email_storage.pruned',
      locationId: LOC_A,
      details: { pruned: 2, bytes_freed: 2_000_000 },
    })
  })

  it('does not audit a prune that freed nothing', async () => {
    await act({ action: 'prune', mailbox_id: MB_STUDIO.id, older_than_days: 30 })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('404s — never 403 — for another studio’s mailbox, and prunes nothing', async () => {
    const { res } = await act({ action: 'prune', mailbox_id: MB_OTHER_LOCATION.id })
    expect(res.status).toBe(404)
    expect(objectKeys(db)).toHaveLength(2)
    expect(usageFor(db, LOC_A, MB_ACCOUNTS.id).bytes_used).toBe(EMAIL_MAILBOX_QUOTA_BYTES)
  })

  it('rejects an unknown action', async () => {
    expect((await act({ action: 'delete_everything' })).res.status).toBe(400)
    expect(writesTo(db)).toEqual([])
  })

  it('targets the unfiled bucket when mailbox_id is explicitly null', async () => {
    const s = storageState()
    s.attachments.push({
      id: 'att-orphan', message_id: 'msg-1', location_id: LOC_A, mailbox_id: null,
      attachment_index: 9, filename: 'orphan.pdf', mime_type: 'application/pdf',
      size_bytes: 500, storage_path: `${LOC_A}/msg-1/9.pdf`, created_at: OLD,
    })
    s.storageUsage.push({
      id: 'u-unfiled', location_id: LOC_A, mailbox_id: null,
      bytes_used: 500, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })
    s.objects.set(`email-attachments/${LOC_A}/msg-1/9.pdf`, { bytes: 'x' })
    db = makeDb(s)
    createServerClient.mockImplementation(() => db)

    const { body } = await act({ action: 'prune', mailbox_id: null, older_than_days: 30 })
    expect(body.data).toMatchObject({ pruned: 1, bytes_freed: 500 })
    expect(usageFor(db, LOC_A, null).bytes_used).toBe(0)
    // The real account is untouched.
    expect(usageFor(db, LOC_A, MB_ACCOUNTS.id).bytes_used).toBe(EMAIL_MAILBOX_QUOTA_BYTES)
  })
})

describe('POST recalculate — the drift repair', () => {
  it('re-derives the counters from the rows', async () => {
    // The counter says full; the rows say 2 MB. Drift is what this fixes.
    const { res } = await act({ action: 'recalculate' })
    expect(res.status).toBe(200)
    expect(usageFor(db, LOC_A, MB_ACCOUNTS.id).bytes_used).toBe(2_000_000)
    expect(usageFor(db, LOC_A, MB_STUDIO.id).bytes_used).toBe(0)
  })

  it('destroys nothing', async () => {
    await act({ action: 'recalculate' })
    expect(objectKeys(db)).toHaveLength(2)
    expect(db._state.attachments.every(a => a.storage_path)).toBe(true)
  })
})
