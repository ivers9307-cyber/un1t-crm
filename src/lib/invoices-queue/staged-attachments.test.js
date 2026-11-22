import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError, logWarn } from '@/lib/log'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/lib/email-attachment-quota'
import {
  INVOICE_STAGING_BUCKET,
  SHIM_MAX_ATTACHMENTS_PER_MESSAGE,
  resolveInboundAttachments,
  removeStagedAttachments,
} from './staged-attachments'

const blobOf = (bytes) => ({
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
})

let download
let remove
let db

beforeEach(() => {
  vi.clearAllMocks()
  download = vi.fn(async () => ({ data: blobOf(Buffer.from('123456789')), error: null }))
  remove = vi.fn(async () => ({ data: [], error: null }))
  db = {
    storage: {
      from: vi.fn((bucket) => {
        expect(bucket).toBe('inbound-invoices')
        return { download, remove }
      }),
    },
  }
})

const email = (attachments) => ({ MessageID: 'm1', Attachments: attachments })
const staged = (index, path, bytes, name = 'a.pdf') => ({
  Name: name,
  Content: '',
  _un1t_staged: { v: 1, path, bytes },
})

describe('resolveInboundAttachments', () => {
  it('exposes the bucket name', () => {
    expect(INVOICE_STAGING_BUCKET).toBe('inbound-invoices')
  })

  it('returns inline attachments untouched and downloads nothing', async () => {
    const inline = { Name: 'a.pdf', Content: 'QUJD' }
    const r = await resolveInboundAttachments(db, email([inline]))
    expect(r).toEqual({ ok: true, attachments: [inline], failed: [], stagedPaths: [] })
    expect(r.attachments[0]).toBe(inline)
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads a staged attachment and attaches its bytes', async () => {
    const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/m1/0.pdf', 9)]))
    expect(r.ok).toBe(true)
    expect(download).toHaveBeenCalledWith('inbound/m1/0.pdf')
    expect(Buffer.isBuffer(r.attachments[0].bytes)).toBe(true)
    expect(r.attachments[0].bytes.toString()).toBe('123456789')
    expect(r.attachments[0].Content).toBe('')
    expect(r.attachments[0]._un1t_staged).toBeUndefined()
    expect(r.stagedPaths).toEqual(['inbound/m1/0.pdf'])
  })

  it('refuses a path that does not belong to this message', async () => {
    const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/other/0.pdf', 9)]))
    expect(download).not.toHaveBeenCalled()
    expect(r.failed).toEqual([{ index: 0, name: 'a.pdf', reason: 'rehost_failed' }])
    expect(r.attachments).toEqual([null])
    expect(r.stagedPaths).toEqual([])
  })

  it('reports an attachment the shim could not move', async () => {
    const r = await resolveInboundAttachments(
      db,
      email([{ Name: 'big.pdf', Content: '', _un1t_staged: { v: 1, error: 'too_large' } }]),
    )
    expect(r.failed).toEqual([{ index: 0, name: 'big.pdf', reason: 'too_large' }])
    expect(r.attachments).toEqual([null])
  })

  it('names an unnamed failed attachment by position', async () => {
    const r = await resolveInboundAttachments(
      db,
      email([{ Content: 'x' }, { Name: '', Content: '', _un1t_staged: { v: 1, error: 'upload_failed' } }]),
    )
    expect(r.failed).toEqual([{ index: 1, name: 'attachment-2', reason: 'rehost_failed' }])
  })

  it('fails the whole call when a download errors', async () => {
    download.mockResolvedValueOnce({ data: null, error: { message: 'x' } })
    const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/m1/0.pdf', 9)]))
    expect(r).toEqual({ ok: false, error: 'staged_download_failed' })
    expect(logError).toHaveBeenCalled()
  })

  it('treats a size mismatch as not received', async () => {
    download.mockResolvedValueOnce({ data: blobOf(Buffer.from('1234')), error: null })
    const r = await resolveInboundAttachments(db, email([staged(0, 'inbound/m1/0.pdf', 9)]))
    expect(r.ok).toBe(true)
    expect(r.failed).toEqual([{ index: 0, name: 'a.pdf', reason: 'rehost_failed' }])
    expect(r.attachments).toEqual([null])
    expect(logWarn).toHaveBeenCalled()
  })

  it('leaves out skipIndexes without downloading', async () => {
    const r = await resolveInboundAttachments(
      db,
      email([staged(0, 'inbound/m1/0.pdf', 9), staged(1, 'inbound/m1/1.pdf', 9, 'b.pdf')]),
      { skipIndexes: new Set([0]) },
    )
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith('inbound/m1/1.pdf')
    expect(r.attachments[0]).toBeNull()
    expect(r.attachments[1].Name).toBe('b.pdf')
    expect(r.failed).toEqual([])
    expect(r.stagedPaths).toEqual(['inbound/m1/1.pdf'])
  })

  it('keeps a null entry as null and does not report it', async () => {
    const r = await resolveInboundAttachments(db, email([null, { Name: 'a.pdf', Content: 'x' }]))
    expect(r.attachments[0]).toBeNull()
    expect(r.attachments[1].Name).toBe('a.pdf')
    expect(r.failed).toEqual([])
  })

  it('handles a missing Attachments array', async () => {
    expect(await resolveInboundAttachments(db, { MessageID: 'm1' })).toEqual({
      ok: true,
      attachments: [],
      failed: [],
      stagedPaths: [],
    })
  })

  it('mirrors the shim cap of 25 attachments per message', () => {
    expect(SHIM_MAX_ATTACHMENTS_PER_MESSAGE).toBe(25)
  })

  it('is the same constant the quota module pins to the shim', () => {
    expect(SHIM_MAX_ATTACHMENTS_PER_MESSAGE).toBe(MAX_ATTACHMENTS_PER_MESSAGE)
  })

  it('reports an attachment the shim emptied without a marker as rehost_failed', async () => {
    const list = [{ Content: 'x' }, { Content: 'x' }, { Content: 'x' }, { Name: 'bad.pdf', Content: '', ContentLength: 6 }]
    const r = await resolveInboundAttachments(db, email(list))
    expect(r.failed).toEqual([{ index: 3, name: 'bad.pdf', reason: 'rehost_failed' }])
    expect(r.attachments[3]).toBeNull()
    expect(download).not.toHaveBeenCalled()
  })

  it('reports an attachment past the shim cap as too_many', async () => {
    const list = Array.from({ length: 25 }, () => ({ Content: 'x' }))
    list.push({ Name: 'extra.pdf', Content: '', ContentLength: 6 })
    const r = await resolveInboundAttachments(db, email(list))
    expect(r.failed).toEqual([{ index: 25, name: 'extra.pdf', reason: 'too_many' }])
    expect(r.attachments[25]).toBeNull()
  })

  it('passes a real empty file through untouched', async () => {
    const empty = { Name: 'empty.pdf', Content: '', ContentLength: 0 }
    const r = await resolveInboundAttachments(db, email([empty]))
    expect(r.failed).toEqual([])
    expect(r.attachments[0]).toBe(empty)
  })

  it('leaves an inline attachment with Content alone, whatever its ContentLength', async () => {
    const inline = { Name: 'a.pdf', Content: 'QUJD', ContentLength: 3 }
    const r = await resolveInboundAttachments(db, email([inline]))
    expect(r.failed).toEqual([])
    expect(r.attachments[0]).toBe(inline)
  })

  it('skips an already-stored index before checking for an emptied attachment', async () => {
    const r = await resolveInboundAttachments(
      db,
      email([{ Name: 'done.pdf', Content: '', ContentLength: 6 }]),
      { skipIndexes: new Set([0]) },
    )
    expect(r.failed).toEqual([])
    expect(r.attachments).toEqual([null])
  })

  it('downloads one at a time', async () => {
    let release
    const gate = new Promise((res) => { release = res })
    download.mockImplementationOnce(async () => {
      await gate
      return { data: blobOf(Buffer.from('123456789')), error: null }
    })
    const p = resolveInboundAttachments(
      db,
      email([staged(0, 'inbound/m1/0.pdf', 9), staged(1, 'inbound/m1/1.pdf', 9, 'b.pdf')]),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(download).toHaveBeenCalledTimes(1)
    release()
    const r = await p
    expect(download).toHaveBeenCalledTimes(2)
    expect(r.stagedPaths).toEqual(['inbound/m1/0.pdf', 'inbound/m1/1.pdf'])
  })
})

describe('removeStagedAttachments', () => {
  it('does nothing for an empty list', async () => {
    await removeStagedAttachments(db, [])
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes the given paths', async () => {
    await removeStagedAttachments(db, ['inbound/m1/0.pdf'])
    expect(remove).toHaveBeenCalledWith(['inbound/m1/0.pdf'])
  })

  it('never removes a path outside inbound/', async () => {
    const stored = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/invoice.pdf'
    await removeStagedAttachments(db, [stored, 'inbound/m1/0.pdf', null])
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(['inbound/m1/0.pdf'])
    await removeStagedAttachments(db, [stored])
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('never throws', async () => {
    remove.mockRejectedValueOnce(new Error('boom'))
    await expect(removeStagedAttachments(db, ['inbound/m1/0.pdf'])).resolves.toBeUndefined()
    remove.mockResolvedValueOnce({ data: null, error: { message: 'x' } })
    await expect(removeStagedAttachments(db, ['inbound/m1/0.pdf'])).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledTimes(2)
  })
})
