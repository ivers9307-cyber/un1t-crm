// IMAP-CONNECTOR Phase 4 — staging one IMAP message's attachments.
//
// THE FOUR PROPERTIES THIS FILE EXISTS FOR
//
// 1. THE OUTPUT IS INDISTINGUISHABLE FROM THE EDGE SHIM'S. Every assertion
//    about a marker below goes through readStagedMarker() — the REAL reader
//    src/lib/email-attachments-server.js uses — with the same
//    (postmarkMessageId, index) pair the webhook route passes it. A test that
//    hand-compared object literals could pass against a marker the route would
//    refuse; this one cannot.
//
// 2. A FILE NEVER COSTS AN EMAIL. Oversized, unreadable, Storage down, a
//    MessageID that cannot key a path — every one of them still returns an
//    entry, still returns normally, and marks the file so the route records a
//    row an operator can act on.
//
// 3. BYTES ARE NEVER COUNTED TWICE AND OBJECTS NEVER ACCUMULATE. The cursor
//    only advances on a 2xx, so re-polling the same UID is DESIGNED. Running
//    the same message twice must leave one object at one key and move no
//    counter (the route owns the metering — see the module header).
//
// 4. NOTHING HERE TOUCHES A TABLE. This is a bytes-mover; the row is the
//    route's job. `db.inserts` staying empty is part of the contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeDb, objectKeys } from '@/app/api/email/tickets/_test-db'
import { readStagedMarker, STAGED_MARKER_KEY } from '@/lib/email-attachment-staging'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '@/lib/email-attachment-quota'
import {
  MAX_ATTACHMENT_PARTS,
  attachmentParts,
  canStageForMessage,
  stageImapAttachments,
} from './imap-attachments'

const MAILBOX = 'b0000000-0000-4000-8000-000000000002'

// A synthetic MessageID in a shape stagedAttachmentPath() will accept:
// /^[A-Za-z0-9_-]{1,64}$/. See the precondition in the module header — the
// dotted/colonned `imap:<uuid>:<rfc-id>` form is pinned separately below.
const MSG = 'imap-a0000000000040008000000000000001-9f3c1d77'

const BUCKET = 'email-attachments'

// ── Fixtures ────────────────────────────────────────────────────────────
// imapflow's parsed BODYSTRUCTURE: `part` is the FETCH part id, `size` is the
// ENCODED octet count, and multipart nodes hold no bytes of their own.

const textBody = { part: '1', type: 'text/plain', encoding: '7bit', size: 400 }
const htmlBody = { part: '1', type: 'text/html', encoding: 'quoted-printable', size: 900 }

const pdfPart = (over = {}) => ({
  part: '2',
  type: 'application/pdf',
  encoding: 'base64',
  size: 1400,
  disposition: 'attachment',
  dispositionParameters: { filename: 'invoice.pdf' },
  ...over,
})

const mixed = (childNodes) => ({ type: 'multipart/mixed', childNodes })

const message = (bodyStructure, uid = 42) => ({ uid, bodyStructure })

/**
 * A read-only imapflow stand-in. `parts` maps a part id to the DECODED buffer
 * downloadMany() hands back (it decodes base64/quoted-printable itself, which
 * is why sizes here are byte lengths and not base64 lengths).
 */
function makeClient(parts = {}, { throwOn = null } = {}) {
  return {
    calls: [],
    async downloadMany(uid, [part], options) {
      this.calls.push({ uid, part, options })
      if (throwOn === part) throw new Error('socket hang up')
      if (!(part in parts)) return {}
      return { [part]: { content: parts[part] } }
    },
  }
}

const marker = (entry, index) => readStagedMarker(entry, { postmarkMessageId: MSG, index })

let db
let error
let warn
beforeEach(() => {
  db = makeDb()
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  error.mockRestore()
  warn.mockRestore()
})

// ── The walk ────────────────────────────────────────────────────────────

describe('attachmentParts — files, not the body', () => {
  it('leaves text/plain and text/html alone', () => {
    expect(attachmentParts(mixed([textBody, htmlBody]))).toEqual({ parts: [], overflow: 0 })
  })

  it('finds a disposition:attachment part', () => {
    const { parts } = attachmentParts(mixed([textBody, pdfPart()]))
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ part: '2', contentType: 'application/pdf', filename: 'invoice.pdf' })
  })

  it('finds a named part even with no disposition at all', () => {
    // Plenty of senders omit Content-Disposition entirely and only set
    // Content-Type: …; name="x". Dropping those would lose real files.
    const node = { part: '2', type: 'text/calendar', encoding: '7bit', size: 90, parameters: { name: 'invite.ics' } }
    expect(attachmentParts(mixed([textBody, node])).parts).toHaveLength(1)
  })

  it('finds an inline cid: image that has no filename', () => {
    const img = { part: '2', type: 'image/png', encoding: 'base64', size: 200, disposition: 'inline', id: '<logo@un1t.com>' }
    const { parts } = attachmentParts({ type: 'multipart/related', childNodes: [htmlBody, img] })
    expect(parts).toHaveLength(1)
    // MIME wraps a Content-ID in angle brackets; Postmark hands over a bare one.
    expect(parts[0].contentId).toBe('logo@un1t.com')
  })

  it('treats an attached message as ONE file, not as its innards', () => {
    const eml = {
      part: '2',
      type: 'message/rfc822',
      encoding: '7bit',
      size: 5000,
      disposition: 'attachment',
      dispositionParameters: { filename: 'forwarded.eml' },
      childNodes: [{ part: '2.1', type: 'application/pdf', encoding: 'base64', size: 900, disposition: 'attachment' }],
    }
    expect(attachmentParts(mixed([textBody, eml])).parts.map(p => p.part)).toEqual(['2'])
  })

  it('is deterministic, depth first — the index IS the attachment_index', () => {
    // UNIQUE (message_id, attachment_index) is what makes a re-poll idempotent
    // (mig 496). A walk that reordered would break that silently.
    const tree = mixed([
      { type: 'multipart/alternative', childNodes: [textBody, htmlBody] },
      pdfPart({ part: '2', dispositionParameters: { filename: 'a.pdf' } }),
      pdfPart({ part: '3', dispositionParameters: { filename: 'b.pdf' } }),
    ])
    expect(attachmentParts(tree).parts.map(p => p.filename)).toEqual(['a.pdf', 'b.pdf'])
    expect(attachmentParts(tree).parts.map(p => p.filename)).toEqual(['a.pdf', 'b.pdf'])
  })

  it('survives a bodyStructure that is missing or junk', () => {
    expect(attachmentParts(undefined)).toEqual({ parts: [], overflow: 0 })
    expect(attachmentParts(null)).toEqual({ parts: [], overflow: 0 })
    expect(attachmentParts('not a tree')).toEqual({ parts: [], overflow: 0 })
  })
})

// ── E1: the single-part message ─────────────────────────────────────────

describe('attachmentParts — a SINGLE-PART, attachment-only message', () => {
  // A scanner or a fax-to-email gateway sends exactly this: no multipart
  // wrapper at all, the top-level Content-Type IS the file. imapflow only sets
  // `part` once the walk is at least one level deep, so the root of a
  // non-multipart message carries NONE — and a leaf has no childNodes, so a
  // walk that required `part` returned []. There was then no attachment row,
  // no skipped_reason and no log line, and because selectBodyParts()
  // (imap-poll.js) also declines a non-text/* root the ticket was completely
  // empty. RFC 3501 numbers the body of a non-multipart message '1', which is
  // exactly what the sibling module already asks for.
  const scan = (over = {}) => ({
    type: 'application/pdf',
    encoding: 'base64',
    size: 1400,
    disposition: 'attachment',
    dispositionParameters: { filename: 'scan.pdf' },
    ...over,
  })

  it('🔴 finds it, and addresses it as part 1', () => {
    expect(attachmentParts(scan())).toEqual({
      parts: [{
        part: '1',
        contentType: 'application/pdf',
        filename: 'scan.pdf',
        contentId: '',
        encoding: 'base64',
        size: 1400,
      }],
      overflow: 0,
    })
  })

  it('🔴 finds one with no disposition either — Content-Type name only', () => {
    const { parts } = attachmentParts({
      type: 'application/pdf', encoding: 'base64', size: 900, parameters: { name: 'scan.pdf' },
    })
    expect(parts.map(p => p.part)).toEqual(['1'])
  })

  it('still leaves a single-part text/plain message alone — that IS the body', () => {
    // The same root fallback must not turn every plain-text email into an
    // attachment; selectBodyParts() claims this one as TextBody.
    expect(attachmentParts({ type: 'text/plain', encoding: '7bit', size: 400 }).parts).toEqual([])
    expect(attachmentParts({ type: 'text/html', encoding: 'quoted-printable', size: 900 }).parts).toEqual([])
  })

  it('🔴 does not turn an EMPTY bodyStructure into a phantom attachment', () => {
    // The root fallback makes every root addressable, so the permissive tail of
    // isAttachmentNode would otherwise call a typeless `{}` a file, stage part
    // '1' — the message BODY — as one, and put it on the ticket as
    // `attachment` / application/octet-stream. A leaf with no declared type is
    // a structure imapflow did not parse, not a file.
    expect(attachmentParts({})).toEqual({ parts: [], overflow: 0 })
    expect(attachmentParts({ type: '' })).toEqual({ parts: [], overflow: 0 })
    expect(attachmentParts({ type: '', childNodes: [] })).toEqual({ parts: [], overflow: 0 })
  })

  it('still trusts a declared disposition over a missing type', () => {
    // The strong signals stay strong: something that says it is an attachment
    // is one even when the sender omitted Content-Type.
    const { parts } = attachmentParts(mixed([
      textBody,
      { part: '2', encoding: 'base64', size: 90, disposition: 'attachment', dispositionParameters: { filename: 'x.bin' } },
    ]))
    expect(parts.map(p => p.part)).toEqual(['2'])
  })

  it('does NOT claim part 1 for a partless node deeper in the tree', () => {
    // Only the ROOT of a non-multipart message is legitimately part '1'.
    // Anywhere else a missing `part` means a structure we cannot address, and
    // staging it as '1' would put some other part's bytes on the ticket under
    // this one's name.
    const orphan = { type: 'application/pdf', encoding: 'base64', size: 700, disposition: 'attachment' }
    expect(attachmentParts(mixed([textBody, orphan])).parts).toEqual([])
  })

  it('stages the bytes end to end, through the ROUTE’s own reader', async () => {
    const bytes = Buffer.from('%PDF-1.4 scanned by the office printer')
    const client = makeClient({ 1: bytes })
    const out = await stageImapAttachments(db, client, message(scan()), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(client.calls.map(c => c.part)).toEqual(['1'])
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments[0].Name).toBe('scan.pdf')
    expect(marker(out.attachments[0], 0)).toEqual({
      kind: 'staged', path: `inbound/${MSG}/0.pdf`, sizeBytes: bytes.length,
    })
    expect(objectKeys(db)).toEqual([`${BUCKET}/inbound/${MSG}/0.pdf`])
  })
})

// ── E2: the walk is bounded ─────────────────────────────────────────────

describe('attachmentParts — the walk is bounded', () => {
  /** One multipart/mixed carrying `n` tiny attachment parts. */
  const manyParts = (n) => mixed([
    textBody,
    ...Array.from({ length: n }, (_, i) => pdfPart({
      part: String(i + 2),
      size: 10,
      dispositionParameters: { filename: `f${i}.pdf` },
    })),
  ])

  it('🔴 stops enumerating at MAX_ATTACHMENT_PARTS and COUNTS the rest', () => {
    // Unbounded, a message with a few thousand tiny parts inflates the
    // forwarded JSON past Vercel's ~4.5 MB body cap. That is answered with a
    // plain-text 413 BEFORE the route runs, and since the cursor only advances
    // on a 2xx the poller re-polls the same UID forever — the mailbox never
    // ingests another email again.
    const { parts, overflow } = attachmentParts(manyParts(4000))
    expect(parts).toHaveLength(MAX_ATTACHMENT_PARTS)
    expect(overflow).toBe(4000 - MAX_ATTACHMENT_PARTS)
    // 🔴 LOAD-BEARING, not decoration. The overflow entry carries no marker, so
    // it is only ever RECORDED if its array position is past
    // MAX_ATTACHMENTS_PER_MESSAGE — that is the route's `too_many` branch.
    // Lower the walk bound under the per-message cap and the entry would
    // instead reach storeOne(), read as `inline`, decode the empty Content to
    // nothing and write no row: the excess would vanish in silence, which is
    // the exact outcome this bound exists to prevent.
    expect(MAX_ATTACHMENT_PARTS).toBeGreaterThan(MAX_ATTACHMENTS_PER_MESSAGE)
  })

  it('takes the FIRST parts, so the index is still stable across polls', () => {
    const { parts } = attachmentParts(manyParts(MAX_ATTACHMENT_PARTS + 5))
    expect(parts[0].filename).toBe('f0.pdf')
    expect(parts[MAX_ATTACHMENT_PARTS - 1].filename).toBe(`f${MAX_ATTACHMENT_PARTS - 1}.pdf`)
  })

  it('does not fire on an ordinary message', () => {
    expect(attachmentParts(manyParts(MAX_ATTACHMENT_PARTS)).overflow).toBe(0)
    expect(attachmentParts(mixed([textBody, pdfPart()])).overflow).toBe(0)
  })
})

describe('stageImapAttachments — past the walk bound', () => {
  const manyParts = (n, filename = (i) => `f${i}.pdf`) => mixed([
    textBody,
    ...Array.from({ length: n }, (_, i) => pdfPart({
      part: String(i + 2),
      size: 10,
      dispositionParameters: { filename: filename(i) },
    })),
  ])

  it('🔴 files the message, bounded, with the excess VISIBLY accounted for', async () => {
    const bytes = {}
    for (let i = 0; i < 3000; i += 1) bytes[String(i + 2)] = Buffer.from('x')

    const out = await stageImapAttachments(db, makeClient(bytes), message(manyParts(3000)), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    // Bounded: the enumerated parts, plus ONE entry that says there was more.
    expect(out.attachments).toHaveLength(MAX_ATTACHMENT_PARTS + 1)

    const tail = out.attachments[MAX_ATTACHMENT_PARTS]
    // No marker — the route's own `too_many` branch fires on the ARRAY
    // POSITION (which is past MAX_ATTACHMENTS_PER_MESSAGE by construction)
    // before it ever consults one, and records a row from ContentLength.
    expect(tail[STAGED_MARKER_KEY]).toBeUndefined()
    expect(tail.Content).toBe('')
    expect(tail.ContentLength).toBeGreaterThan(0)
    // …and it NAMES the excess, so an operator can ask for a resend rather
    // than never learning the files existed.
    expect(tail.Name).toContain(String(3000 - MAX_ATTACHMENT_PARTS))
    expect(out.skipped.at(-1)).toEqual({ name: tail.Name, reason: 'too_many' })
    // 'too_many' is in mig 496's CHECK vocabulary; anything else fails the insert.
    expect(['quota', 'too_large', 'too_many', 'rehost_failed', 'pruned'])
      .toContain(out.skipped.at(-1).reason)

    // Only the first MAX_ATTACHMENTS_PER_MESSAGE were ever downloaded.
    expect(objectKeys(db)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(error.mock.calls.some(c => String(c[0]).includes('more parts than the walk'))).toBe(true)
  })

  it('🔴 keeps the forwarded payload far below Vercel’s ~4.5 MB body cap', async () => {
    // THE PROPERTY THAT ACTUALLY MATTERS. Vercel answers a body over ~4.5 MB
    // with a plain-text 413 BEFORE the route runs, and the cursor only advances
    // on a 2xx — so an over-cap payload is not a dropped attachment, it is a
    // mailbox that re-polls the same UID every five minutes and never ingests
    // another email again.
    const VERCEL_BODY_CAP = 4.5 * 1024 * 1024
    const TOTAL = 20_000
    // Filenames are the sender's, up to ATTACHMENT_FILENAME_MAX (200) each.
    const tree = manyParts(TOTAL, (i) => `${String(i).padStart(6, '0')}-${'invoice'.repeat(27)}.pdf`)

    const bytes = {}
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i += 1) bytes[String(i + 2)] = Buffer.from('x')

    const out = await stageImapAttachments(db, makeClient(bytes), message(tree), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    // The fixture really is over the cap unbounded — measured off a REAL entry
    // this run produced, so the arithmetic cannot drift away from the code.
    const perEntry = Buffer.byteLength(JSON.stringify(out.attachments[100]))
    expect(perEntry * TOTAL).toBeGreaterThan(VERCEL_BODY_CAP)

    const payloadBytes = Buffer.byteLength(JSON.stringify({ Attachments: out.attachments }))
    expect(payloadBytes).toBeLessThan(VERCEL_BODY_CAP / 8)
  })

  it('adds nothing at all when the bound was not reached', async () => {
    const out = await stageImapAttachments(db, makeClient({ 2: Buffer.from('x') }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(out.attachments).toHaveLength(1)
    expect(out.skipped).toEqual([])
  })
})

// ── The happy path ──────────────────────────────────────────────────────

describe('stageImapAttachments — a normal attachment', () => {
  it('uploads the bytes and returns a marker the ROUTE accepts', async () => {
    const bytes = Buffer.from('%PDF-1.4 a real invoice')
    const client = makeClient({ 2: bytes })

    const out = await stageImapAttachments(db, client, message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(out.skipped).toEqual([])
    expect(out.attachments).toHaveLength(1)

    const entry = out.attachments[0]
    // Postmark's own fields survive; Content is EMPTIED, never deleted.
    expect(entry.Name).toBe('invoice.pdf')
    expect(entry.ContentType).toBe('application/pdf')
    expect(entry.Content).toBe('')
    // The measured decoded length, not the BODYSTRUCTURE estimate.
    expect(entry.ContentLength).toBe(bytes.length)

    // THE CONTRACT ASSERTION: the route's own reader, with the ids the route
    // holds, must resolve this to staged bytes at a key it re-derived itself.
    expect(marker(entry, 0)).toEqual({
      kind: 'staged',
      path: `inbound/${MSG}/0.pdf`,
      sizeBytes: bytes.length,
    })

    // …and the bytes really are at that key.
    expect(objectKeys(db)).toEqual([`${BUCKET}/inbound/${MSG}/0.pdf`])
    const object = db._state.objects.get(`${BUCKET}/inbound/${MSG}/0.pdf`)
    expect(object.bytes).toBe(bytes)
    expect(object.opts).toEqual({ contentType: 'application/pdf', upsert: true })
  })

  it('writes no table row — the route files, this only moves bytes', async () => {
    await stageImapAttachments(db, makeClient({ 2: Buffer.from('x') }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(db.inserts).toEqual([])
    expect(db.updates).toEqual([])
  })

  it('does NOT move the storage counter — storeOne() reserves, exactly once', async () => {
    // Reserving here as well would bill every IMAP attachment twice and halve
    // the mailbox's 5 GB with nothing on any screen to explain it.
    await stageImapAttachments(db, makeClient({ 2: Buffer.from('x') }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(db.rpcs).toEqual([])
  })

  it('carries a Content-ID through for an inline image', async () => {
    const png = Buffer.from('\x89PNG logo bytes')
    const img = { part: '2', type: 'image/png', encoding: 'base64', size: 200, disposition: 'inline', id: '<logo@un1t.com>' }
    const out = await stageImapAttachments(
      db,
      makeClient({ 2: png }),
      message({ type: 'multipart/related', childNodes: [htmlBody, img] }),
      { mailboxId: MAILBOX, messageId: MSG },
    )

    const entry = out.attachments[0]
    expect(entry.ContentID).toBe('logo@un1t.com')
    // No filename anywhere in the part, so the row gets the sanitiser's
    // fallback rather than an empty NOT NULL column.
    expect(entry.Name).toBe('attachment')
    expect(marker(entry, 0)).toEqual({ kind: 'staged', path: `inbound/${MSG}/0.png`, sizeBytes: png.length })
  })

  it('gives an ordinary attachment no ContentID field at all', async () => {
    const out = await stageImapAttachments(db, makeClient({ 2: Buffer.from('x') }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect('ContentID' in out.attachments[0]).toBe(false)
  })
})

describe('stageImapAttachments — a message with no attachments', () => {
  it('returns empty, downloads nothing, uploads nothing', async () => {
    const client = makeClient()
    const out = await stageImapAttachments(db, client, message(mixed([textBody, htmlBody])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(out).toEqual({ attachments: [], skipped: [] })
    expect(client.calls).toEqual([])
    expect(objectKeys(db)).toEqual([])
  })
})

// ── Degrading, never failing ────────────────────────────────────────────

describe('stageImapAttachments — an oversized part', () => {
  it('is refused on the ENCODED size, without ever being downloaded', async () => {
    // 0.72 × 40 MB is already past the 25 MiB ceiling, so the file is past the
    // ceiling and there is no reason to pull it down the wire to find out.
    const client = makeClient({ 2: Buffer.from('never reached') })
    const out = await stageImapAttachments(db, client, message(mixed([textBody, pdfPart({ size: 40_000_000 })])), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(client.calls).toEqual([])
    expect(objectKeys(db)).toEqual([])
    // The mail is still perfectly fine — one entry, visibly skipped.
    expect(out.attachments).toHaveLength(1)
    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'skip', reason: 'too_large' })
    expect(out.skipped).toEqual([{ name: 'invoice.pdf', reason: 'too_large' }])
  })

  it('is refused on the DECODED length too, when BODYSTRUCTURE understated it', async () => {
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
    const out = await stageImapAttachments(db, makeClient({ 2: huge }), message(mixed([textBody, pdfPart({ size: 10 })])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'skip', reason: 'too_large' })
    expect(objectKeys(db)).toEqual([])
  })

  it('does not apply the base64 floor to quoted-printable', async () => {
    // quoted-printable can decode to a third of its encoded length, so the
    // early screen would mark an ordinary file too_large.
    const bytes = Buffer.from('small after decoding')
    const qp = pdfPart({ encoding: 'quoted-printable', size: 40_000_000 })
    const out = await stageImapAttachments(db, makeClient({ 2: bytes }), message(mixed([textBody, qp])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(marker(out.attachments[0], 0).kind).toBe('staged')
  })
})

describe('stageImapAttachments — an upload failure', () => {
  it('degrades to rehost_failed and never throws', async () => {
    db = makeDb({ storageErrors: { upload: { message: 'storage 500 service unavailable' } } })
    const out = await stageImapAttachments(db, makeClient({ 2: Buffer.from('bytes') }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(out.attachments).toHaveLength(1)
    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'skip', reason: 'rehost_failed' })
    expect(out.skipped).toEqual([{ name: 'invoice.pdf', reason: 'rehost_failed' }])
    expect(objectKeys(db)).toEqual([])
  })

  it('keeps staging the REST of the message after one file fails', async () => {
    // A partial failure must not turn into a total one — the second file is
    // fine and there is no reason for it to go missing with the first.
    let calls = 0
    db = makeDb()
    const realFrom = db.storage.from
    db.storage.from = (bucket) => {
      const api = realFrom(bucket)
      const upload = api.upload
      api.upload = (...args) => {
        calls += 1
        return calls === 1
          ? Promise.resolve({ data: null, error: { message: 'transient' } })
          : upload(...args)
      }
      return api
    }

    const tree = mixed([
      textBody,
      pdfPart({ part: '2', dispositionParameters: { filename: 'a.pdf' } }),
      pdfPart({ part: '3', dispositionParameters: { filename: 'b.pdf' } }),
    ])
    const out = await stageImapAttachments(db, makeClient({ 2: Buffer.from('aa'), 3: Buffer.from('bbb') }), message(tree), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'skip', reason: 'rehost_failed' })
    expect(marker(out.attachments[1], 1)).toEqual({ kind: 'staged', path: `inbound/${MSG}/1.pdf`, sizeBytes: 3 })
  })

  it('marks a part it could not download, rather than dropping it', async () => {
    // "We do not have the file" is a row an operator can act on. Silence is not.
    const out = await stageImapAttachments(
      db,
      makeClient({ 2: Buffer.from('x') }, { throwOn: '2' }),
      message(mixed([textBody, pdfPart()])),
      { mailboxId: MAILBOX, messageId: MSG },
    )
    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'skip', reason: 'rehost_failed' })
  })

  it('records NO marker for a part that decodes to nothing', async () => {
    // size_bytes > 0 is a CHECK, so there is no legal row — the route's inline
    // path answers "nothing usable" and writes none. Identical to the shim.
    const out = await stageImapAttachments(db, makeClient({ 2: Buffer.alloc(0) }), message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: MSG,
    })
    expect(out.attachments[0][STAGED_MARKER_KEY]).toBeUndefined()
    expect(marker(out.attachments[0], 0)).toEqual({ kind: 'inline' })
    expect(out.attachments[0].Content).toBe('')
    expect(out.skipped).toEqual([{ name: 'invoice.pdf', reason: 'empty' }])
  })
})

describe('stageImapAttachments — past the per-message cap', () => {
  it('strips Content and leaves the too_many branch to the route', async () => {
    const children = [textBody]
    const bytes = {}
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE + 2; i += 1) {
      const part = String(i + 2)
      children.push(pdfPart({ part, dispositionParameters: { filename: `f${i}.pdf` }, size: 1400 }))
      bytes[part] = Buffer.from('x')
    }
    const out = await stageImapAttachments(db, makeClient(bytes), message(mixed(children)), {
      mailboxId: MAILBOX, messageId: MSG,
    })

    expect(out.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE + 2)
    // The route's own `too_many` branch fires on the ARRAY POSITION before it
    // ever consults a marker, so there must not be one here.
    const last = out.attachments[MAX_ATTACHMENTS_PER_MESSAGE]
    expect(last[STAGED_MARKER_KEY]).toBeUndefined()
    expect(last.Content).toBe('')
    // …and it records the row from ContentLength, so that has to be a real
    // number rather than the placeholder 1.
    expect(last.ContentLength).toBe(1050) // 1400 encoded × 3/4
    expect(objectKeys(db)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(out.skipped.filter(s => s.reason === 'too_many')).toHaveLength(2)
  })
})

// ── The MessageID precondition ──────────────────────────────────────────

describe('the MessageID must be able to key an object', () => {
  it('accepts the shape stagedAttachmentPath accepts, and nothing else', () => {
    expect(canStageForMessage(MSG)).toBe(true)
    expect(canStageForMessage('a'.repeat(64))).toBe(true)
    expect(canStageForMessage('a'.repeat(65))).toBe(false)
    expect(canStageForMessage('')).toBe(false)
    expect(canStageForMessage(undefined)).toBe(false)
    // …and every character that could add a path segment or walk up one.
    expect(canStageForMessage('../etc/passwd')).toBe(false)
    expect(canStageForMessage('a/b')).toBe(false)
  })

  it('refuses to upload — but still shows the file — when it cannot', async () => {
    // The design's synthetic id is `imap:<mailbox_id>:<rfc-message-id>`, which
    // is neither short enough nor in the alphabet stagedAttachmentPath()
    // accepts. This pins the behaviour rather than leaving it to be discovered
    // in production: the mail files, the file is visibly not stored, and no
    // bytes are put in a metered bucket that nothing would ever name.
    const unsafe = 'imap:a0000000-0000-4000-8000-000000000001:<CAF=abc@mail.gmail.com>'
    const client = makeClient({ 2: Buffer.from('bytes') })
    const out = await stageImapAttachments(db, client, message(mixed([textBody, pdfPart()])), {
      mailboxId: MAILBOX, messageId: unsafe,
    })

    expect(out.attachments).toHaveLength(1)
    expect(readStagedMarker(out.attachments[0], { postmarkMessageId: unsafe, index: 0 }))
      .toEqual({ kind: 'skip', reason: 'rehost_failed' })
    expect(out.skipped).toEqual([{ name: 'invoice.pdf', reason: 'rehost_failed' }])
    expect(client.calls).toEqual([])
    expect(objectKeys(db)).toEqual([])
    // Said once, loudly, naming the cause — it is a per-MAILBOX fault, not a
    // per-file one.
    expect(error.mock.calls.some(c => String(c[0]).includes('not a safe path segment'))).toBe(true)
  })
})

// ── Re-processing ───────────────────────────────────────────────────────

describe('re-polling the same message is idempotent', () => {
  it('overwrites one object at one key and returns an identical payload', async () => {
    // The cursor only advances on a 2xx, so a 5xx genuinely re-polls the same
    // UID. Two passes must be indistinguishable from one.
    const bytes = Buffer.from('%PDF-1.4 a real invoice')
    const tree = mixed([
      textBody,
      pdfPart({ part: '2', dispositionParameters: { filename: 'a.pdf' } }),
      { part: '3', type: 'image/png', encoding: 'base64', size: 300, disposition: 'inline', id: '<logo@x>' },
    ])
    const client = makeClient({ 2: bytes, 3: Buffer.from('png') })
    const args = { mailboxId: MAILBOX, messageId: MSG }

    const first = await stageImapAttachments(db, client, message(tree), args)
    const second = await stageImapAttachments(db, client, message(tree), args)

    expect(second).toEqual(first)
    expect(objectKeys(db).sort()).toEqual([
      `${BUCKET}/inbound/${MSG}/0.pdf`,
      `${BUCKET}/inbound/${MSG}/1.png`,
    ])
    // The path is a pure function of (MessageID, index), so the second pass
    // rewrote the same keys rather than leaving a second set nothing accounts
    // for. And the counter is still untouched — the route owns it.
    expect(db.rpcs).toEqual([])
  })
})
