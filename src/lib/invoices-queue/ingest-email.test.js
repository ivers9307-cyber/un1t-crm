import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createFakeDb } from '../../../tests/helpers/fake-db.js'
import { ingestInboundEmail } from './ingest-email.js'

vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))

const LOC = { id: '11111111-1111-4111-8111-111111111111' }
const seed = () => ({ invoices_queue: [] })
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64')
const PDF = b64('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('logo-bytes-here')]).toString('base64')

const pdf = (over = {}) => ({ Name: 'a.pdf', ContentType: 'application/pdf', Content: PDF, ...over })
const logo = () => ({ Name: 'logo.png', ContentType: 'image/png', Content: PNG, ContentID: 'logo1' })
const html = '<p>hi</p><img src="cid:logo1">'
const email = (Attachments, over = {}) => ({
  MessageID: 'm1',
  Subject: 'Invoice',
  From: 'sender@example.com',
  FromFull: { Email: 'sender@example.com' },
  TextBody: 'hello',
  Attachments,
  ...over,
})
const all = async (db) => (await db.from('invoices_queue').select('*').order('email_message_id')).data

const PDF_BYTES = Buffer.from(PDF, 'base64')
const B_BYTES = Buffer.from('%PDF-1.4\n2 0 obj\n<<>>\nendobj\n', 'latin1')
// The shim's shape: bytes parked at inbound/<MessageID>/<index>.<ext>, Content emptied.
const staged = (index, over = {}, bytes = PDF_BYTES) => {
  const path = `inbound/m1/${index}.pdf`
  files.set(path, bytes)
  return { Name: `s${index}.pdf`, ContentType: 'application/pdf', Content: '', _un1t_staged: { v: 1, path, bytes: bytes.length }, ...over }
}
const notMoved = (error, over = {}) => ({ Name: 'huge.pdf', ContentType: 'application/pdf', Content: '', _un1t_staged: { v: 1, error }, ...over })

let db, upload, download, remove, buckets, files, args
const fakeStorage = () => ({
  from: (bucket) => {
    buckets.push(bucket)
    return { upload, download, remove }
  },
})
beforeEach(() => {
  db = createFakeDb({ tables: seed() })
  files = new Map()
  buckets = []
  upload = vi.fn(async () => ({ error: null }))
  download = vi.fn(async (path) => (files.has(path)
    ? { data: new Blob([files.get(path)]), error: null }
    : { data: null, error: { message: 'Object not found' } }))
  remove = vi.fn(async (paths) => {
    for (const p of paths) files.delete(p)
    return { data: [], error: null }
  })
  db.storage = fakeStorage()
  args = { location: LOC, body: email([pdf(), pdf({ Name: 'b.pdf' })]) }
})

describe('ingestInboundEmail', () => {
  it('stores each attachment once with hash and body', async () => {
    const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf(), pdf({ Name: 'b.pdf' })]) })
    expect(r).toMatchObject({ ok: true, alreadyStored: 0 })
    const rows = await all(db)
    expect(rows.map((x) => x.email_message_id).sort()).toEqual(['m1', 'm1-1'])
    expect(rows.every((x) => x.content_hash && x.attachment_path && x.email_body_text === 'hello')).toBe(true)
    expect(rows.every((x) => x.status === 'received' && x.source_type === 'supplier_email')).toBe(true)
  })

  it('a retry after the second upload failed leaves two rows, not three', async () => {
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    expect(await ingestInboundEmail(db, args)).toEqual({ ok: false, error: 'storage_upload_failed' })
    expect(await all(db)).toHaveLength(1)
    const again = await ingestInboundEmail(db, args)
    expect(again).toMatchObject({ ok: true, alreadyStored: 1 })
    expect(again.created).toHaveLength(1)
    expect(await all(db)).toHaveLength(2)
  })

  it('redoes a row that never got its file', async () => {
    await db.from('invoices_queue').insert({
      location_id: LOC.id, email_message_id: 'm1', status: 'received',
      source_type: 'supplier_email', attachment_bucket: 'inbound-invoices',
    })
    const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf()]) })
    expect(r).toMatchObject({ ok: true, alreadyStored: 0 })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].attachment_path).toBeTruthy()
  })

  it('records why an email had nothing usable', async () => {
    await ingestInboundEmail(db, { location: LOC, body: email([{ Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }]) })
    const [row] = await all(db)
    expect(row).toMatchObject({ status: 'received', not_invoice_reason: 'unsupported_type: application/msword', attachment_path: null })
  })

  it('says no_attachment when there were none', async () => {
    await ingestInboundEmail(db, { location: LOC, body: email([]) })
    expect((await all(db))[0]).toMatchObject({ not_invoice_reason: 'no_attachment', email_body_text: 'hello' })
  })

  it('does not add a second empty row on retry', async () => {
    await ingestInboundEmail(db, { location: LOC, body: email([]) })
    const again = await ingestInboundEmail(db, { location: LOC, body: email([]) })
    expect(again).toMatchObject({ ok: true, created: [] })
    expect(await all(db)).toHaveLength(1)
  })

  it('counts skipped logos on the first row', async () => {
    await ingestInboundEmail(db, { location: LOC, body: email([pdf(), logo()], { HtmlBody: html }) })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].skipped_attachment_count).toBe(1)
  })

  it('reports an insert failure', async () => {
    const bad = createFakeDb({ tables: seed(), errors: { invoices_queue: { insert: { message: 'x' } } } })
    bad.storage = db.storage
    expect(await ingestInboundEmail(bad, args)).toEqual({ ok: false, error: 'insert_failed' })
  })

  it('counts skipped logos once, even across a retry', async () => {
    const a = { location: LOC, body: email([pdf(), logo(), pdf({ Name: 'b.pdf' })], { HtmlBody: html }) }
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    expect((await ingestInboundEmail(db, a)).ok).toBe(false)
    expect((await ingestInboundEmail(db, a)).ok).toBe(true)
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.skipped_attachment_count > 0)).toHaveLength(1)
  })

  it('fails with lookup_failed and writes nothing when the pre-read fails', async () => {
    const bad = createFakeDb({ tables: seed(), errors: { invoices_queue: { select: { message: 'x' } } } })
    bad.storage = db.storage
    expect(await ingestInboundEmail(bad, args)).toEqual({ ok: false, error: 'lookup_failed' })
    expect(bad.tables.invoices_queue).toHaveLength(0)
    expect(upload).not.toHaveBeenCalled()
  })

  it('treats a duplicate-key insert as already stored', async () => {
    const dup = createFakeDb({ tables: seed(), errors: { invoices_queue: { insert: { code: '23505', message: 'dup' } } } })
    dup.storage = db.storage
    const r = await ingestInboundEmail(dup, { location: LOC, body: email([pdf()]) })
    expect(r).toEqual({ ok: true, created: [], rowIds: [], alreadyStored: 1, skippedInline: 0, notReceived: 0 })
    expect(upload).not.toHaveBeenCalled()
  })
  it('fails when the path update fails, and a retry leaves one row with a path', async () => {
    db.errors.invoices_queue = { update: { message: 'down' } }
    const one = { location: LOC, body: email([pdf()]) }
    expect(await ingestInboundEmail(db, one)).toEqual({ ok: false, error: 'path_update_failed' })
    delete db.errors.invoices_queue
    expect(await ingestInboundEmail(db, one)).toMatchObject({ ok: true })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].attachment_path).toBeTruthy()
  })

  it('fails when the path update matches no row (removed by another delivery)', async () => {
    const realFrom = db.from.bind(db)
    db.from = (t) => {
      const q = realFrom(t)
      const realUpdate = q.update.bind(q)
      q.update = (row, o) => {
        // Simulate the row disappearing between insert and update.
        db.tables.invoices_queue = []
        return realUpdate(row, o)
      }
      return q
    }
    expect(await ingestInboundEmail(db, { location: LOC, body: email([pdf()]) })).toEqual({ ok: false, error: 'path_update_failed' })
  })

  it('after a failed upload whose rollback also failed, a retry leaves one row with a path', async () => {
    upload.mockResolvedValueOnce({ error: { message: 'boom' } })
    db.errors.invoices_queue = { delete: { message: 'down' } }
    const one = { location: LOC, body: email([pdf()]) }
    expect(await ingestInboundEmail(db, one)).toEqual({ ok: false, error: 'storage_upload_failed' })
    expect(await all(db)).toHaveLength(1)
    delete db.errors.invoices_queue
    expect(await ingestInboundEmail(db, one)).toMatchObject({ ok: true })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].attachment_path).toBeTruthy()
  })

  it('never deletes a path-less row someone has already acted on', async () => {
    await db.from('invoices_queue').insert({
      location_id: LOC.id, email_message_id: 'm1', status: 'rejected',
      source_type: 'supplier_email', attachment_bucket: 'inbound-invoices',
    })
    const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf()]) })
    expect(r).toEqual({ ok: true, created: [], rowIds: [], alreadyStored: 1, skippedInline: 0, notReceived: 0 })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('rejected')
    expect(upload).not.toHaveBeenCalled()
  })
  it('never deletes a row a concurrent delivery finished between our read and our delete', async () => {
    await db.from('invoices_queue').insert({
      location_id: LOC.id, email_message_id: 'm1', status: 'received',
      source_type: 'supplier_email', attachment_bucket: 'inbound-invoices',
    })
    // The second query on the table is the delete: the other delivery's path lands just before it.
    const realFrom = db.from.bind(db)
    let n = 0
    db.from = (table) => {
      if (table === 'invoices_queue' && ++n === 2) db.tables.invoices_queue[0].attachment_path = 'loc/done.pdf'
      return realFrom(table)
    }
    const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf()]) })
    expect(r).toEqual({ ok: true, created: [], rowIds: [], alreadyStored: 1, skippedInline: 0, notReceived: 0 })
    expect(db.tables.invoices_queue).toHaveLength(1)
    expect(db.tables.invoices_queue[0].attachment_path).toBe('loc/done.pdf')
    expect(upload).not.toHaveBeenCalled()
  })

  it('never creates an empty-email row on a retry where the only usable attachment is already stored', async () => {
    const a = { location: LOC, body: email([{ Name: 'a.docx', ContentType: 'application/msword', Content: 'AAAA' }, pdf()]) }
    expect(await ingestInboundEmail(db, a)).toMatchObject({ ok: true })
    expect(await ingestInboundEmail(db, a)).toMatchObject({ ok: true, alreadyStored: 1, created: [] })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].attachment_path).toBeTruthy()
  })

  it('keeps the second of two inline images on a retry when the first was stored', async () => {
    const a = {
      location: LOC,
      body: email([logo(), { ...logo(), Name: 'IMG_2.png', ContentID: 'logo2' }], { HtmlBody: '<img src="cid:logo1"><img src="cid:logo2">' }),
    }
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    expect((await ingestInboundEmail(db, a)).ok).toBe(false)
    expect(await ingestInboundEmail(db, a)).toMatchObject({ ok: true, alreadyStored: 1, skippedInline: 0 })
    expect(await all(db)).toHaveLength(2)
  })
})

describe('ingestInboundEmail with attachments the shim parked in Storage', () => {
  it('stores a staged PDF with its hash and path, then removes the staged file', async () => {
    const pathAtRemove = []
    remove.mockImplementation(async (paths) => {
      pathAtRemove.push(db.tables.invoices_queue[0]?.attachment_path)
      for (const p of paths) files.delete(p)
      return { data: [], error: null }
    })
    const r = await ingestInboundEmail(db, { location: LOC, body: email([staged(0)]) })
    expect(r).toMatchObject({ ok: true, alreadyStored: 0, notReceived: 0 })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email_message_id: 'm1',
      attachment_filename: 's0.pdf',
      attachment_mime_type: 'application/pdf',
      attachment_size_bytes: PDF_BYTES.length,
      content_hash: createHash('sha256').update(PDF_BYTES).digest('hex'),
    })
    expect(rows[0].attachment_path).toBeTruthy()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith('inbound/m1/0.pdf')
    expect(upload.mock.calls[0][1].equals(PDF_BYTES)).toBe(true)
    expect(remove).toHaveBeenCalledWith(['inbound/m1/0.pdf'])
    expect(pathAtRemove).toEqual([rows[0].attachment_path])
    expect(new Set(buckets)).toEqual(new Set(['inbound-invoices']))
  })

  it('a second identical call stores nothing and needs no staged file', async () => {
    const body = email([staged(0)])
    expect((await ingestInboundEmail(db, { location: LOC, body })).ok).toBe(true)
    expect(files.size).toBe(0)
    download.mockClear()
    const again = await ingestInboundEmail(db, { location: LOC, body })
    expect(again).toEqual({ ok: true, created: [], rowIds: [], alreadyStored: 1, skippedInline: 0, notReceived: 0 })
    expect(download).not.toHaveBeenCalled()
    expect(await all(db)).toHaveLength(1)
  })

  it('keeps the staged files after a partial failure; the retry downloads only the missing one', async () => {
    const body = email([staged(0), staged(1, {}, B_BYTES)])
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    expect(await ingestInboundEmail(db, { location: LOC, body })).toEqual({ ok: false, error: 'storage_upload_failed' })
    expect(remove).not.toHaveBeenCalled()
    expect(files.size).toBe(2)
    download.mockClear()
    expect(await ingestInboundEmail(db, { location: LOC, body })).toMatchObject({ ok: true, alreadyStored: 1 })
    expect(download.mock.calls).toEqual([['inbound/m1/1.pdf']])
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    expect(rows.every((x) => x.attachment_path && x.content_hash)).toBe(true)
    // Both staged files go once the email is fully stored, the skipped one too.
    expect(files.size).toBe(0)
  })

  it('records a too_large attachment beside a good PDF, once', async () => {
    const body = email([staged(0), notMoved('too_large')])
    const r = await ingestInboundEmail(db, { location: LOC, body })
    expect(r).toMatchObject({ ok: true, notReceived: 1 })
    expect(r.created).toHaveLength(1)
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    const missing = rows.find((x) => x.email_message_id === 'm1-missing-1')
    expect(missing).toMatchObject({
      attachment_filename: 'huge.pdf',
      attachment_path: null,
      attachment_mime_type: null,
      attachment_size_bytes: null,
      not_invoice_reason: 'attachment_not_received: too_large',
      status: 'received',
      source_type: 'supplier_email',
      sender_email: 'sender@example.com',
      subject: 'Invoice',
      email_body_text: 'hello',
      attachment_bucket: 'inbound-invoices',
      location_id: LOC.id,
    })
    expect(await ingestInboundEmail(db, { location: LOC, body })).toMatchObject({ ok: true, notReceived: 0, alreadyStored: 1 })
    expect(await all(db)).toHaveLength(2)
  })

  it('names an unnamed attachment that was not received by its position', async () => {
    await ingestInboundEmail(db, { location: LOC, body: email([pdf(), notMoved('upload_failed', { Name: undefined })]) })
    const missing = (await all(db)).find((x) => x.email_message_id === 'm1-missing-1')
    expect(missing).toMatchObject({ attachment_filename: 'attachment-2', not_invoice_reason: 'attachment_not_received: rehost_failed' })
  })

  it('an email whose attachments all failed gets only the not-received rows', async () => {
    const body = email([notMoved('too_large'), notMoved('upload_failed', { Name: 'x.pdf' })])
    const r = await ingestInboundEmail(db, { location: LOC, body })
    const rows = await all(db)
    expect(r).toEqual({ ok: true, created: [], rowIds: rows.map((x) => x.id), alreadyStored: 0, skippedInline: 0, notReceived: 2 })
    expect(r.rowIds).toHaveLength(2)
    expect(rows.map((x) => x.email_message_id)).toEqual(['m1-missing-0', 'm1-missing-1'])
    expect(rows.map((x) => x.not_invoice_reason)).toEqual(['attachment_not_received: too_large', 'attachment_not_received: rehost_failed'])
    expect(rows.some((x) => x.not_invoice_reason === 'no_attachment')).toBe(false)
    expect(await ingestInboundEmail(db, { location: LOC, body })).toMatchObject({ ok: true, notReceived: 0 })
    expect(await all(db)).toHaveLength(2)
  })

  it('records attachments past the shim cap as not received, once', async () => {
    // The shim stages the first 25 and empties the rest with no marker.
    const list = Array.from({ length: 25 }, (_, i) => staged(i))
    list.push(
      { Name: 'x25.pdf', ContentType: 'application/pdf', Content: '', ContentLength: 6 },
      { Name: 'x26.pdf', ContentType: 'application/pdf', Content: '', ContentLength: 6 },
    )
    const body = email(list)
    const r = await ingestInboundEmail(db, { location: LOC, body })
    expect(r).toMatchObject({ ok: true, notReceived: 2 })
    expect(r.created).toHaveLength(25)
    const rows = await all(db)
    expect(rows.filter((x) => x.attachment_path)).toHaveLength(25)
    const missing = rows.filter((x) => x.email_message_id.includes('-missing-'))
    expect(missing.map((x) => x.email_message_id).sort()).toEqual(['m1-missing-25', 'm1-missing-26'])
    expect(missing.every((x) => x.not_invoice_reason === 'attachment_not_received: too_many')).toBe(true)
    expect(await ingestInboundEmail(db, { location: LOC, body })).toMatchObject({ ok: true, created: [], notReceived: 0 })
    expect(await all(db)).toHaveLength(27)
  })

  it('records a staged file of the wrong size as not received and keeps the staged file', async () => {
    const body = email([staged(0, { _un1t_staged: { v: 1, path: 'inbound/m1/0.pdf', bytes: PDF_BYTES.length + 1 } })])
    const r = await ingestInboundEmail(db, { location: LOC, body })
    expect(r).toMatchObject({ ok: true, created: [], notReceived: 1 })
    const rows = await all(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email_message_id: 'm1-missing-0', not_invoice_reason: 'attachment_not_received: rehost_failed' })
    expect(files.has('inbound/m1/0.pdf')).toBe(true)
    expect(remove).not.toHaveBeenCalled()
  })

  it('fails with staged_download_failed and writes nothing when a download fails', async () => {
    const body = email([staged(0), staged(1)])
    files.delete('inbound/m1/1.pdf')
    expect(await ingestInboundEmail(db, { location: LOC, body })).toEqual({ ok: false, error: 'staged_download_failed' })
    expect(await all(db)).toHaveLength(0)
    expect(upload).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('stores an inline (non-staged) email exactly as before, touching no staged file', async () => {
    const r = await ingestInboundEmail(db, args)
    expect(r).toMatchObject({ ok: true, alreadyStored: 0, notReceived: 0 })
    expect(r.created).toHaveLength(2)
    expect(await all(db)).toHaveLength(2)
    expect(download).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('never deletes a not-received row as if it were a half-written one', async () => {
    const { data: seeded } = await db.from('invoices_queue').insert({
      location_id: LOC.id, email_message_id: 'm1-missing-1', status: 'received',
      source_type: 'supplier_email', attachment_bucket: 'inbound-invoices',
      not_invoice_reason: 'attachment_not_received: too_large',
    }).select('id').single()
    const r = await ingestInboundEmail(db, { location: LOC, body: email([staged(0), notMoved('too_large')]) })
    expect(r).toMatchObject({ ok: true, notReceived: 0 })
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    expect(rows.find((x) => x.email_message_id === 'm1-missing-1').id).toBe(seeded.id)
    expect(db.calls.some((c) => c.table === 'invoices_queue' && c.op === 'delete')).toBe(false)
  })

  it('fails with insert_failed when a not-received row cannot be written, keeping staged files', async () => {
    const bad = createFakeDb({ tables: seed(), errors: { invoices_queue: { insert: { message: 'x' } } } })
    bad.storage = fakeStorage()
    expect(await ingestInboundEmail(bad, { location: LOC, body: email([notMoved('too_large')]) })).toEqual({ ok: false, error: 'insert_failed' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('treats a duplicate-key not-received insert as already present', async () => {
    const dup = createFakeDb({ tables: seed(), errors: { invoices_queue: { insert: { code: '23505', message: 'dup' } } } })
    dup.storage = fakeStorage()
    expect(await ingestInboundEmail(dup, { location: LOC, body: email([notMoved('too_large')]) }))
      .toEqual({ ok: true, created: [], rowIds: [], alreadyStored: 0, skippedInline: 0, notReceived: 0 })
  })

  // INVOICEPREP.3 — rowIds lists every row this call inserted, for queueing.
  describe('rowIds', () => {
    it('lists every stored row, and a repeat inserts none', async () => {
      const r = await ingestInboundEmail(db, args)
      const rows = await all(db)
      expect(r.created).toHaveLength(2)
      expect(r.rowIds.slice().sort()).toEqual(rows.map((x) => x.id).sort())
      const again = await ingestInboundEmail(db, args)
      expect(again.rowIds).toEqual([])
    })

    it('includes the not-received rows beside the stored ones', async () => {
      const r = await ingestInboundEmail(db, { location: LOC, body: email([pdf(), notMoved('too_large')]) })
      const rows = await all(db)
      expect(r.created).toHaveLength(1)
      expect(r.notReceived).toBe(1)
      expect(r.rowIds.slice().sort()).toEqual(rows.map((x) => x.id).sort())
      expect(r.rowIds).toHaveLength(2)
    })

    it('includes the single empty-email row, once', async () => {
      const r = await ingestInboundEmail(db, { location: LOC, body: email([]) })
      const rows = await all(db)
      expect(r.rowIds).toEqual([rows[0].id])
      expect((await ingestInboundEmail(db, { location: LOC, body: email([]) })).rowIds).toEqual([])
    })
  })
})
