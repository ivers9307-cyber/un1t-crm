// EMAIL-ATTACH.1 — storing inbound attachments and metering the bytes.
//
// THE THREE PROPERTIES THIS FILE EXISTS FOR
//
// 1. THE MESSAGE IS FILED NO MATTER WHAT. Every failure mode — oversized,
//    over quota, Storage down, counter RPC down, undecodable base64 — must
//    end in a ROW WITH A REASON and never in a throw. The webhook's whole
//    hardening history is mail that vanished silently; an attachment must
//    never be able to reintroduce that.
//
// 2. BYTES ARE NEVER COUNTED TWICE. The webhook releases its dedupe claim on
//    any 5xx so Postmark's retry genuinely re-processes the message
//    (EMAIL-DEDUPE-RELEASE.1), which makes double processing DESIGNED, not
//    hypothetical. `runs the same payload twice` below is the proof: after two
//    identical runs the counter reads exactly one file's worth.
//
// 3. THE COUNTER IS RESERVED BEFORE THE UPLOAD AND ROLLED BACK ON REFUSAL, so
//    two attachments arriving together cannot both be told there is room. The
//    fake models add_email_storage_bytes for real (returning the post-increment
//    total) — a stubbed RPC would make every quota assertion here pass for the
//    wrong reason.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { makeDb, insertsInto, objectKeys, usageFor } from '@/app/api/email/tickets/_test-db'
import {
  decodeAttachmentContent,
  getMailboxQuota,
  pruneMailboxAttachments,
  recalcStorageUsage,
  signedAttachmentUrl,
  storeInboundAttachments,
} from './email-attachments-server'
import { EMAIL_MAILBOX_QUOTA_BYTES, MAX_ATTACHMENT_BYTES } from './email-attachment-quota'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const MAILBOX = 'b0000000-0000-4000-8000-000000000002'
const MESSAGE = 'c0000000-0000-4000-8000-000000000003'

const b64 = (n, fill = 'x') => Buffer.from(fill.repeat(n)).toString('base64')

/** A Postmark inbound attachment. `Content` is base64, as it arrives. */
function attachment(overrides = {}) {
  return {
    Name: 'invoice.pdf',
    ContentType: 'application/pdf',
    Content: b64(1000),
    // Sender-supplied and DELIBERATELY WRONG in most fixtures — nothing may
    // trust it over the decoded length.
    ContentLength: 999_999,
    ...overrides,
  }
}

const store = (db, attachments, extra = {}) => storeInboundAttachments(db, {
  attachments, messageId: MESSAGE, locationId: LOC, mailboxId: MAILBOX, ...extra,
})

let db
let warn
let error
beforeEach(() => {
  db = makeDb()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
})

describe('decodeAttachmentContent — base64 length is NOT byte length', () => {
  it('returns the DECODED bytes', () => {
    const bytes = decodeAttachmentContent(b64(300))
    expect(bytes.length).toBe(300)
    // The encoded string is ~4/3 longer. Metering that would over-count every
    // attachment by a third.
    expect(b64(300).length).toBeGreaterThan(300)
  })
  it('returns null for nothing usable', () => {
    expect(decodeAttachmentContent('')).toBeNull()
    expect(decodeAttachmentContent(null)).toBeNull()
    expect(decodeAttachmentContent(undefined)).toBeNull()
    expect(decodeAttachmentContent(12345)).toBeNull()
    expect(decodeAttachmentContent('!!!!')).toBeNull()
  })
})

describe('the happy path', () => {
  it('uploads the bytes, records the row and meters the decoded length', async () => {
    const summary = await store(db, [attachment()])

    expect(summary).toMatchObject({ stored: 1, skipped: 0, deduped: 0, bytesStored: 1000 })

    const rows = insertsInto(db, 'email_ticket_attachments')
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({
      message_id: MESSAGE,
      location_id: LOC,
      mailbox_id: MAILBOX,
      attachment_index: 0,
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      // NOT ContentLength (999,999) and NOT the base64 string length.
      size_bytes: 1000,
      skipped_reason: null,
    })
    expect(rows[0].payload.storage_path).toBe(`${LOC}/${MESSAGE}/0.pdf`)

    expect(objectKeys(db)).toEqual([`email-attachments/${LOC}/${MESSAGE}/0.pdf`])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
  })

  it('addresses the object by IDS, never by the attacker-supplied filename', async () => {
    await store(db, [attachment({ Name: '../../../etc/passwd', ContentType: 'application/pdf' })])

    const [row] = insertsInto(db, 'email_ticket_attachments')
    expect(row.payload.storage_path).toBe(`${LOC}/${MESSAGE}/0.pdf`)
    // The name survives as DATA, sanitised, so staff still see what arrived.
    expect(row.payload.filename).not.toContain('/')
    expect(objectKeys(db)[0]).not.toContain('..')
  })

  it('numbers several attachments by their position in the payload', async () => {
    const summary = await store(db, [
      attachment({ Name: 'a.pdf', Content: b64(10) }),
      attachment({ Name: 'b.png', ContentType: 'image/png', Content: b64(20) }),
    ])
    expect(summary.stored).toBe(2)
    expect(insertsInto(db, 'email_ticket_attachments').map(i => i.payload.attachment_index))
      .toEqual([0, 1])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(30)
  })

  it('does nothing at all for a message with no attachments', async () => {
    expect(await store(db, [])).toMatchObject({ stored: 0, skipped: 0 })
    expect(await store(db, undefined)).toMatchObject({ stored: 0 })
    expect(insertsInto(db, 'email_ticket_attachments')).toEqual([])
    expect(usageFor(db, LOC, MAILBOX)).toBeNull()
  })
})

describe('THE ACCOUNTING IS IDEMPOTENT', () => {
  it('runs the same payload twice and counts the bytes ONCE', async () => {
    const payload = [attachment({ Content: b64(4096) })]

    const first = await store(db, payload)
    const usedAfterFirst = usageFor(db, LOC, MAILBOX).bytes_used

    // Exactly what Postmark's retry does after the route released its dedupe
    // claim on a 5xx: the SAME payload, the same message row, again.
    const second = await store(db, payload)

    expect(first).toMatchObject({ stored: 1, bytesStored: 4096 })
    expect(second).toMatchObject({ stored: 0, deduped: 1, bytesStored: 0 })

    expect(usedAfterFirst).toBe(4096)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(4096) // NOT 8192
    expect(db._state.attachments).toHaveLength(1)
    expect(objectKeys(db)).toHaveLength(1)
  })

  it('stays correct across three runs and a mixed payload', async () => {
    const payload = [
      attachment({ Name: 'a.pdf', Content: b64(100) }),
      attachment({ Name: 'huge.zip', ContentType: 'application/zip', Content: b64(50) }),
    ]
    await store(db, payload)
    await store(db, payload)
    await store(db, payload)

    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(150)
    expect(db._state.attachments).toHaveLength(2)
  })

  it('releases the reservation when the row insert loses a RACE (23505)', async () => {
    // The pre-check cannot see a row a concurrent run has not committed yet, so
    // the unique index is the real guard. Simulate it by planting the row
    // between the pre-check and the insert.
    const original = db.from
    let planted = false
    db.from = (table) => {
      const b = original(table)
      if (table === 'email_ticket_attachments') {
        const originalThen = b.then
        b.maybeSingle = () => {
          if (!planted) {
            planted = true
            // The "other" run's row lands now — after we looked, before we write.
            db._state.attachments.push({
              id: 'raced', message_id: MESSAGE, attachment_index: 0,
              location_id: LOC, mailbox_id: MAILBOX, size_bytes: 700,
              storage_path: `${LOC}/${MESSAGE}/0.pdf`,
            })
          }
          return Promise.resolve({ data: null, error: null }) // we saw nothing
        }
        b.then = originalThen
      }
      return b
    }

    const summary = await store(db, [attachment({ Content: b64(700) })])
    db.from = original

    expect(summary).toMatchObject({ stored: 0, deduped: 1 })
    // Reserved 700, then gave all 700 back — net zero.
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    // The object is LEFT: the path is deterministic, so what we uploaded is
    // byte-identical to what the winning row points at. Deleting it would
    // break their row.
    expect(objectKeys(db)).toEqual([`email-attachments/${LOC}/${MESSAGE}/0.pdf`])
  })
})

describe('the quota', () => {
  it('records skipped_reason quota and stores NOTHING once the ceiling is passed', async () => {
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX,
      bytes_used: EMAIL_MAILBOX_QUOTA_BYTES, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })

    const summary = await store(db, [attachment({ Content: b64(2048) })])

    expect(summary).toMatchObject({ stored: 0, skipped: 1, reasons: { quota: 1 } })
    const [row] = insertsInto(db, 'email_ticket_attachments')
    // The XOR: no path, a reason, and the SIZE and NAME kept so staff can ask
    // for a resend.
    expect(row.payload.storage_path).toBeNull()
    expect(row.payload.skipped_reason).toBe('quota')
    expect(row.payload.size_bytes).toBe(2048)
    expect(row.payload.filename).toBe('invoice.pdf')
    // Nothing was uploaded, and the reservation was given back in full.
    expect(objectKeys(db)).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(EMAIL_MAILBOX_QUOTA_BYTES)
  })

  it('stores what fits and refuses the rest — a straddling message is partial, not all-or-nothing', async () => {
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX,
      bytes_used: 0, quota_bytes: 1500,
    })

    const summary = await store(db, [
      attachment({ Name: 'fits.pdf', Content: b64(1000) }),
      attachment({ Name: 'does-not.pdf', Content: b64(1000) }),
    ])

    expect(summary).toMatchObject({ stored: 1, skipped: 1, reasons: { quota: 1 } })
    const rows = insertsInto(db, 'email_ticket_attachments').map(i => i.payload)
    expect(rows[0].storage_path).not.toBeNull()
    expect(rows[1].skipped_reason).toBe('quota')
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(1000)
  })

  it('honours a per-mailbox quota override rather than the 5 GB default', async () => {
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX, bytes_used: 0, quota_bytes: 100,
    })
    const summary = await store(db, [attachment({ Content: b64(500) })])
    expect(summary.reasons).toEqual({ quota: 1 })
  })

  it('meters a NULL mailbox against the location unfiled bucket, not nowhere', async () => {
    const summary = await storeInboundAttachments(db, {
      attachments: [attachment({ Content: b64(64) })],
      messageId: MESSAGE, locationId: LOC, mailboxId: null,
    })
    expect(summary.stored).toBe(1)
    expect(usageFor(db, LOC, null).bytes_used).toBe(64)
    expect(usageFor(db, LOC, MAILBOX)).toBeNull()
  })

  it('getMailboxQuota answers the default for a bucket with no row yet', async () => {
    expect(await getMailboxQuota(db, { locationId: LOC, mailboxId: MAILBOX }))
      .toEqual({ bytesUsed: 0, quotaBytes: EMAIL_MAILBOX_QUOTA_BYTES })
  })
})

describe('everything that can go wrong still leaves a ROW and never throws', () => {
  it('too_large for a file over the per-file ceiling — and never uploads it', async () => {
    const big = decodeAttachmentContent(b64(10))
    expect(big).not.toBeNull()
    const summary = await store(db, [attachment({
      Content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64'),
    })])
    expect(summary.reasons).toEqual({ too_large: 1 })
    expect(insertsInto(db, 'email_ticket_attachments')[0].payload.skipped_reason).toBe('too_large')
    expect(objectKeys(db)).toEqual([])
    expect(usageFor(db, LOC, MAILBOX)).toBeNull() // never even reserved
  })

  it('rehost_failed when Storage refuses the upload — and gives the bytes back', async () => {
    db._state.storageErrors.upload = { message: 'bucket unavailable' }
    const summary = await store(db, [attachment({ Content: b64(2048) })])

    expect(summary.reasons).toEqual({ rehost_failed: 1 })
    expect(insertsInto(db, 'email_ticket_attachments')[0].payload.skipped_reason).toBe('rehost_failed')
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
  })

  it('rehost_failed when the counter RPC is down — refuses to store UNMETERED', async () => {
    db._state.errors.add_email_storage_bytes = { message: 'rpc down' }
    const summary = await store(db, [attachment()])
    expect(summary.reasons).toEqual({ rehost_failed: 1 })
    expect(objectKeys(db)).toEqual([])
  })

  it('removes the uploaded object when the row insert fails for a REAL reason', async () => {
    // Not a 23505 — a genuine insert failure. Nothing would ever find the
    // bytes, so they must not be left behind.
    db._state.errors.email_ticket_attachments = { code: '42703', message: 'column gone' }
    const summary = await store(db, [attachment({ Content: b64(300) })])

    expect(summary.reasons).toEqual({ rehost_failed: 1 })
    expect(objectKeys(db)).toEqual([])
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
  })

  it('skips an undecodable attachment without a row and without a throw', async () => {
    const summary = await store(db, [attachment({ Content: '' }), attachment({ Content: null })])
    expect(summary).toMatchObject({ stored: 0, skipped: 0 })
    expect(insertsInto(db, 'email_ticket_attachments')).toEqual([])
  })

  it('never throws, whatever the payload contains', async () => {
    await expect(store(db, [null, undefined, 42, 'nope', {}, { Content: {} }]))
      .resolves.toBeTruthy()
    await expect(storeInboundAttachments(db, { attachments: [attachment()] }))
      .resolves.toMatchObject({ stored: 0 })
  })

  it('records — rather than silently ignoring — attachments past the per-message cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      attachment({ Name: `f${i}.pdf`, Content: b64(10) }))
    const summary = await store(db, many)
    expect(summary.stored).toBe(25)
    expect(summary.reasons.too_many).toBe(5)
    expect(insertsInto(db, 'email_ticket_attachments')).toHaveLength(30)
  })
})

describe('signedAttachmentUrl', () => {
  it('signs a stored object and carries the sanitised download name', async () => {
    await store(db, [attachment()])
    const url = await signedAttachmentUrl(db, `${LOC}/${MESSAGE}/0.pdf`, { filename: 'invoice.pdf' })
    expect(url).toContain('token=signed')
    expect(url).toContain('download=invoice.pdf')
  })
  it('returns null rather than throwing when Storage will not sign', async () => {
    db._state.storageErrors.sign = { message: 'nope' }
    expect(await signedAttachmentUrl(db, 'a/b/0.pdf')).toBeNull()
    expect(await signedAttachmentUrl(db, null)).toBeNull()
  })
})

describe('pruning — the release valve, and it MUST move the counter', () => {
  const OLD = '2020-01-01T00:00:00Z'
  const NEW = '2999-01-01T00:00:00Z'

  function seedPrunable({ status = 'closed', createdAt = OLD, count = 2, size = 1000 } = {}) {
    db._state.tickets.push({ id: 'tk-1', location_id: LOC, mailbox_id: MAILBOX, status })
    db._state.messages.push({ id: 'msg-1', ticket_id: 'tk-1', location_id: LOC })
    for (let i = 0; i < count; i += 1) {
      db._state.attachments.push({
        id: `att-${i}`, message_id: 'msg-1', location_id: LOC, mailbox_id: MAILBOX,
        attachment_index: i, filename: `f${i}.pdf`, mime_type: 'application/pdf',
        size_bytes: size, storage_path: `${LOC}/msg-1/${i}.pdf`, skipped_reason: null,
        created_at: createdAt,
      })
      db._state.objects.set(`email-attachments/${LOC}/msg-1/${i}.pdf`, { bytes: 'x' })
    }
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX,
      bytes_used: size * count, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })
  }

  it('drops the bytes, keeps the record, and DECREMENTS the counter', async () => {
    seedPrunable()

    const res = await pruneMailboxAttachments(db, {
      locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30,
    })

    expect(res).toMatchObject({ ok: true, pruned: 2, bytesFreed: 2000 })
    // The counter is the whole point: leave it high and the mailbox is
    // permanently full for space it no longer holds.
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    // Bytes gone…
    expect(objectKeys(db)).toEqual([])
    // …record kept, with an honest reason, satisfying the stored-XOR-skipped
    // constraint in the other direction.
    for (const row of db._state.attachments) {
      expect(row.storage_path).toBeNull()
      expect(row.skipped_reason).toBe('pruned')
      expect(row.filename).toMatch(/\.pdf$/)
      expect(row.size_bytes).toBe(1000)
    }
  })

  it('is idempotent — a second prune frees nothing and does not decrement again', async () => {
    seedPrunable()
    await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30 })
    const second = await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30 })

    expect(second).toMatchObject({ pruned: 0, bytesFreed: 0 })
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0) // not negative
  })

  it('refuses to touch a ticket someone is still working', async () => {
    seedPrunable({ status: 'open' })
    const res = await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30 })
    expect(res.pruned).toBe(0)
    expect(objectKeys(db)).toHaveLength(2)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(2000)
  })

  it('prunes a solved ticket as well as a closed one', async () => {
    seedPrunable({ status: 'solved' })
    expect((await pruneMailboxAttachments(db, {
      locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30,
    })).pruned).toBe(2)
  })

  it('refuses to touch anything newer than the cutoff', async () => {
    seedPrunable({ createdAt: NEW })
    const res = await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30 })
    expect(res.pruned).toBe(0)
    expect(objectKeys(db)).toHaveLength(2)
  })

  it('prunes the UNFILED bucket when asked for it, and only it', async () => {
    seedPrunable()
    db._state.attachments.push({
      id: 'att-unfiled', message_id: 'msg-1', location_id: LOC, mailbox_id: null,
      attachment_index: 9, filename: 'orphan.pdf', mime_type: 'application/pdf',
      size_bytes: 500, storage_path: `${LOC}/msg-1/9.pdf`, created_at: OLD,
    })
    db._state.objects.set(`email-attachments/${LOC}/msg-1/9.pdf`, { bytes: 'x' })
    db._state.storageUsage.push({
      id: 'u2', location_id: LOC, mailbox_id: null, bytes_used: 500, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })

    const res = await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: null, olderThanDays: 30 })

    expect(res).toMatchObject({ pruned: 1, bytesFreed: 500 })
    expect(usageFor(db, LOC, null).bytes_used).toBe(0)
    // The real mailbox is untouched.
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(2000)
  })

  it('still decrements when the object removal fails, and says so loudly', async () => {
    seedPrunable()
    db._state.storageErrors.remove = { message: 'storage down' }

    const res = await pruneMailboxAttachments(db, { locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30 })

    expect(res.pruned).toBe(2)
    // Rows and counter agree, which is the property that keeps the mailbox
    // usable. The orphaned objects are a cost line, and they are shouted about.
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PRUNE LEFT OBJECTS BEHIND'),
      expect.anything(),
    )
  })

  it('reports what is left when the batch limit is reached', async () => {
    seedPrunable({ count: 3, size: 10 })
    const res = await pruneMailboxAttachments(db, {
      locationId: LOC, mailboxId: MAILBOX, olderThanDays: 30, limit: 2,
    })
    expect(res).toMatchObject({ pruned: 2, remaining: 1 })
  })

  it('refuses without a location rather than pruning everything', async () => {
    expect(await pruneMailboxAttachments(db, { locationId: null })).toMatchObject({ ok: false })
  })
})

describe('recalcStorageUsage — the drift repair', () => {
  it('re-derives a counter that has drifted away from the rows', async () => {
    db._state.attachments.push({
      id: 'a1', message_id: 'm', location_id: LOC, mailbox_id: MAILBOX,
      attachment_index: 0, size_bytes: 750, storage_path: 'p', created_at: '2026-01-01T00:00:00Z',
    })
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX,
      bytes_used: 999_999, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })

    expect(await recalcStorageUsage(db, LOC)).toEqual({ ok: true })
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(750)
  })

  it('ignores rows whose bytes are not actually stored', async () => {
    db._state.attachments.push({
      id: 'a1', message_id: 'm', location_id: LOC, mailbox_id: MAILBOX,
      attachment_index: 0, size_bytes: 750, storage_path: null, skipped_reason: 'pruned',
    })
    db._state.storageUsage.push({
      id: 'u1', location_id: LOC, mailbox_id: MAILBOX, bytes_used: 750, quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
    })
    await recalcStorageUsage(db, LOC)
    expect(usageFor(db, LOC, MAILBOX).bytes_used).toBe(0)
  })
})
