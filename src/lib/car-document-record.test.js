// CARDOCUNIQUE.1 (C129) — recordCarDocument and the unique storage_path
// (mig 693). The losing insert of two concurrent finalise calls on one slot
// fails 23505 on car_documents_storage_path_key: that is "already saved",
// and the stored object belongs to the winner's row, so it must NOT be
// removed. Any other insert failure still removes the object (no orphans).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromCarDocument: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { enqueueFromCarDocument } from '@/lib/invoices-queue/enqueue'
import { recordCarDocument, CAR_DOCUMENT_ALREADY_SAVED, isCarDocumentPathConflict } from './car-document-record.js'

const CAR = { id: 'c0000000-0000-0000-0000-000000000001' }
const PATH = `${CAR.id}/other/0f8fad5b-d9cb-469f-a165-70867728950e.pdf`
const ARGS = { car: CAR, docType: 'other', storagePath: PATH, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, userId: 'u1', notes: null }
const UNIQUE_PATH = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "car_documents_storage_path_key"',
  details: `Key (storage_path)=(${PATH}) already exists.`,
}

function fakeDb(insertError) {
  const remove = vi.fn(async () => ({ error: null }))
  return {
    remove,
    from: () => ({
      insert: (row) => ({ select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: 'd1', ...row }, error: null }) }) }),
    }),
    storage: { from: () => ({ remove }) },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('recordCarDocument — the unique storage_path (mig 693)', () => {
  it('a 23505 on car_documents_storage_path_key is a conflict: the object is kept and nothing is queued', async () => {
    const db = fakeDb(UNIQUE_PATH)
    expect(await recordCarDocument(db, ARGS)).toEqual({ ok: false, conflict: true, error: CAR_DOCUMENT_ALREADY_SAVED })
    expect(db.remove).not.toHaveBeenCalled()
    expect(enqueueFromCarDocument).not.toHaveBeenCalled()
  })

  it('any other insert failure removes the object (no orphan) and is not a conflict', async () => {
    const db = fakeDb({ code: '23503', message: 'insert or update on table "car_documents" violates foreign key constraint' })
    const rec = await recordCarDocument(db, ARGS)
    expect(rec).toEqual({ ok: false, error: 'insert or update on table "car_documents" violates foreign key constraint' })
    expect(db.remove).toHaveBeenCalledWith([PATH])
  })

  it('a 23505 on another unique key is not a path conflict (the object is ours alone, so it goes)', async () => {
    const db = fakeDb({ code: '23505', message: 'duplicate key value violates unique constraint "car_documents_pkey"' })
    const rec = await recordCarDocument(db, ARGS)
    expect(rec.conflict).toBeUndefined()
    expect(db.remove).toHaveBeenCalledWith([PATH])
  })

  it('records and queues a new path', async () => {
    const db = fakeDb(null)
    const rec = await recordCarDocument(db, ARGS)
    expect(rec.ok).toBe(true)
    expect(rec.doc.storage_path).toBe(PATH)
    expect(enqueueFromCarDocument).toHaveBeenCalledWith('d1')
    expect(db.remove).not.toHaveBeenCalled()
  })

  it('isCarDocumentPathConflict reads the code and the index name, from message or details', () => {
    expect(isCarDocumentPathConflict(UNIQUE_PATH)).toBe(true)
    expect(isCarDocumentPathConflict({ code: '23505', message: 'duplicate key', details: 'constraint "car_documents_storage_path_key"' })).toBe(true)
    expect(isCarDocumentPathConflict({ code: '23505', message: 'duplicate key value violates unique constraint "car_documents_pkey"' })).toBe(false)
    expect(isCarDocumentPathConflict({ code: '409', message: 'car_documents_storage_path_key' })).toBe(false)
    expect(isCarDocumentPathConflict(null)).toBe(false)
  })
})
