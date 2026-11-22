import { describe, it, expect, vi, beforeEach } from 'vitest'
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

let db, upload, args
beforeEach(() => {
  db = createFakeDb({ tables: seed() })
  upload = vi.fn(async () => ({ error: null }))
  db.storage = { from: () => ({ upload }) }
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
    expect(r).toEqual({ ok: true, created: [], alreadyStored: 1, skippedInline: 0 })
    expect(upload).not.toHaveBeenCalled()
  })
})
