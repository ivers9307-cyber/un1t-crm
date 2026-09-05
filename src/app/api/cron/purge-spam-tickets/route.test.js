// MAIL-SPAM.1 — the 30-day purge of still-quarantined mail.
//
// WHAT IT MUST AND MUST NOT DELETE:
//   • deletes a ticket that is `is_spam = true` AND was flagged more than 30
//     days ago — nothing else. A young spam row waits; a non-spam row of any
//     age is never touched; a merged tombstone is left alone.
//   • storage objects go BEFORE rows (the rows are what name them — after the
//     cascade nothing could), and the mailbox counter is decremented by what
//     was freed, or the quota reads full forever.
//   • pages with .range() — every select caps at 1,000 rows whatever the code
//     asks for, so a bare select would silently leave the tail behind.
//   • stamps the heartbeat on success and ONLY on success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import { GET, PURGE_PAGE_SIZE } from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { makeDb, deletesFrom, selectsFrom, objectKeys, usageFor } from '../../email/tickets/_test-db'
import { LOC_A, MB_STUDIO, T_STUDIO } from '../../email/tickets/_test-fixtures'

const NOW = Date.parse('2026-09-05T10:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/purge-spam-tickets', { headers: { authorization: `Bearer ${secret}` } })

function spamTicket(id, flaggedDaysAgo, over = {}) {
  return {
    ...T_STUDIO,
    id,
    is_spam: true,
    spam_score: 8,
    spam_flagged_at: daysAgo(flaggedDaysAgo),
    merged_into_id: null,
    ...over,
  }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

describe('auth', () => {
  it('401s without the secret and touches nothing', async () => {
    setupDb({ tickets: [spamTicket('t-old', 45)] })
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.deletes).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    setupDb({ tickets: [spamTicket('t-old', 45)] })
    expect((await GET(req())).status).toBe(401)
    expect(db.deletes).toEqual([])
  })
})

describe('what gets purged', () => {
  it('deletes only quarantined tickets flagged more than 30 days ago', async () => {
    setupDb({
      tickets: [
        spamTicket('t-old', 45),
        spamTicket('t-edge', 31),
        spamTicket('t-young', 29),
        spamTicket('t-today', 0),
        // Old, but NOT spam — an archived member conversation. Never.
        { ...T_STUDIO, id: 't-archived-old', is_spam: false, status: 'closed', spam_flagged_at: null, closed_at: daysAgo(400) },
        // Released by an operator: flag cleared, flagged_at nulled. Never.
        { ...T_STUDIO, id: 't-released', is_spam: false, spam_score: 9, spam_flagged_at: null },
        // A live row that somehow kept an OLD spam_flagged_at (no code path
        // writes this; the CHECK only constrains the spam side). The flag, not
        // the clock, is what makes a row a candidate — never.
        { ...T_STUDIO, id: 't-live-stale-clock', is_spam: false, spam_flagged_at: daysAgo(50) },
        // A merged tombstone of a LIVE ticket — never a candidate (merged_into_id
        // is set), and its target is not being purged, so it is left alone.
        spamTicket('t-tombstone', 60, { merged_into_id: 't-released' }),
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { tickets_deleted: 2, merge_tombstones_deleted: 0 } })

    const remaining = db._state.tickets.map(t => t.id).sort()
    expect(remaining).toEqual(['t-archived-old', 't-live-stale-clock', 't-released', 't-today', 't-tombstone', 't-young'])
    // Every delete named the is_spam filter — belt and braces on the cascade.
    for (const d of deletesFrom(db, 'email_tickets')) {
      expect(d.filters).toContainEqual(['eq', 'is_spam', true])
    }
    // …and the candidate SCAN itself is scoped to the flag: the count is the
    // ids the scan returned, so an over-broad scan would over-report here.
    expect(body.data.tickets_deleted).toBe(2)
  })

  // mig 536's two NO ACTION foreign keys point at each other once a merge has
  // moved messages (tombstone.merged_into_id → target; target's messages'
  // merged_from_ticket_id → tombstone), so a quarantined merge TARGET and its
  // tombstones must go in ONE statement or the purge fails every night.
  it('deletes a quarantined merge target TOGETHER with its tombstones, in one statement, and leaves other tombstones alone', async () => {
    setupDb({
      tickets: [
        spamTicket('t-target', 45),
        // Two tombstones merged into the target — not spam themselves, never flagged.
        { ...T_STUDIO, id: 't-tomb-1', is_spam: false, spam_flagged_at: null, merged_into_id: 't-target' },
        { ...T_STUDIO, id: 't-tomb-2', is_spam: false, spam_flagged_at: null, merged_into_id: 't-target' },
        // A plain old spam row on the same page.
        spamTicket('t-plain', 40),
        // A tombstone of a LIVE ticket — the merge machinery's, untouched.
        { ...T_STUDIO, id: 't-tomb-live', is_spam: false, spam_flagged_at: null, merged_into_id: 't-live' },
        { ...T_STUDIO, id: 't-live', is_spam: false, spam_flagged_at: null, merged_into_id: null },
      ],
      messages: [
        // The moved message: lives on the target, remembers its tombstone.
        { id: 'msg-moved', ticket_id: 't-target', merged_from_ticket_id: 't-tomb-1', direction: 'inbound', created_at: daysAgo(45) },
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ tickets_deleted: 2, merge_tombstones_deleted: 2 })
    expect(db._state.tickets.map(t => t.id).sort()).toEqual(['t-live', 't-tomb-live'])

    // The target and its tombstones went in ONE delete, still carrying the
    // quarantine as belt-and-braces (in .or() form, since a tombstone is not
    // itself is_spam).
    const pair = deletesFrom(db, 'email_tickets').find(d => d.filters.some(f => f[0] === 'or'))
    expect(pair).toBeTruthy()
    expect(pair.filters).toContainEqual(['in', 'id', expect.arrayContaining(['t-target', 't-tomb-1', 't-tomb-2'])])
    expect(pair.filters.find(f => f[0] === 'or')[1]).toBe('is_spam.eq.true,merged_into_id.in.(t-target)')
    // …and every OTHER delete is the plain quarantined form.
    for (const d of deletesFrom(db, 'email_tickets')) {
      if (d === pair) continue
      expect(d.filters).toContainEqual(['eq', 'is_spam', true])
    }
  })

  it('removes attachment objects and releases the bytes BEFORE the rows go', async () => {
    const path = `${LOC_A}/${MB_STUDIO.id}/msg-1/0-invoice.pdf`
    setupDb({
      tickets: [spamTicket('t-old', 45)],
      messages: [{ id: 'msg-1', ticket_id: 't-old', direction: 'inbound', created_at: daysAgo(45) }],
      attachments: [{
        id: 'att-1', message_id: 'msg-1', location_id: LOC_A, mailbox_id: MB_STUDIO.id,
        storage_path: path, size_bytes: 1200, filename: 'invoice.pdf', mime_type: 'application/pdf',
        forwarded_from_id: null, created_at: daysAgo(45),
      }],
      storageUsage: [{ id: 'u1', location_id: LOC_A, mailbox_id: MB_STUDIO.id, bytes_used: 5000, quota_bytes: 5368709120 }],
    })
    db._state.objects.set(`email-attachments/${path}`, { bytes: Buffer.from('pdf'), opts: {} })

    // Order: the object removal must be observed before the ticket delete.
    const order = []
    const realRemove = db.storage.from('email-attachments').remove
    const realStorageFrom = db.storage.from
    db.storage.from = (bucket) => ({
      ...realStorageFrom(bucket),
      remove: async (paths) => { order.push('remove'); return realRemove(paths) },
    })
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table === 'email_tickets') {
        const origDelete = b.delete
        b.delete = (...a) => { order.push('delete'); return origDelete(...a) }
      }
      return b
    }

    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(objectKeys(db)).toEqual([])
    expect(usageFor(db, LOC_A, MB_STUDIO.id).bytes_used).toBe(3800)
    expect(order).toEqual(['remove', 'delete'])
    expect((await res.json()).data.attachments_removed).toBe(1)
  })

  it('pages through more than one select cap of candidates with .range()', async () => {
    const many = Array.from({ length: PURGE_PAGE_SIZE * 2 + 7 }, (_, i) =>
      spamTicket(`t-${String(i).padStart(4, '0')}`, 40 + (i % 30)))
    // The fake deletes rows IN PLACE from the array it was handed, so the
    // total is captured before the run rather than read off `many` after it.
    const total = many.length
    setupDb({ tickets: many })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.tickets_deleted).toBe(total)
    expect(db._state.tickets).toEqual([])
    // Three pages: PAGE, PAGE, 7 — and every candidate read was ranged
    // (the tombstone scan on the same table pages at SCAN_PAGE, so it is
    // told apart by its window).
    const reads = selectsFrom(db, 'email_tickets')
    expect(reads.length).toBeGreaterThanOrEqual(3)
    const candidateRanges = db.ranges.filter(r => r.table === 'email_tickets' && r.from === 0 && r.to === PURGE_PAGE_SIZE - 1)
    expect(candidateRanges.length).toBe(3)
  })

  it('does nothing and still stamps when there is nothing to purge', async () => {
    setupDb({ tickets: [spamTicket('t-young', 3)] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(db.deletes).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-spam-tickets', expect.objectContaining({ tickets_deleted: 0 }))
  })
})

describe('heartbeat', () => {
  it('stamps purge-spam-tickets with the outcome on success', async () => {
    setupDb({ tickets: [spamTicket('t-old', 45)] })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-spam-tickets', expect.objectContaining({ tickets_deleted: 1 }))
  })

  it('does NOT stamp when the candidate scan fails, and answers 500', async () => {
    setupDb({ tickets: [spamTicket('t-old', 45)], errors: { email_tickets: { code: '42703', message: 'column does not exist' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
