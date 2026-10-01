// CARDOCORPHANS.1 (C130, CLEANUP-1) — the daily sweep of orphaned signed
// uploads in the private car-documents bucket. Richard's call, 1 Oct 2026.
//
// WHAT IT MUST AND MUST NOT REMOVE:
//   • only an object whose WHOLE path is a slot the sign route mints,
//     `<car uuid>/<doc_type>/<uuid>.<ext>` (parseCarDocumentUploadPath);
//   • only when it is more than 24 hours old (an upload whose finalise is
//     still coming is minutes old);
//   • only when no car_documents.storage_path names it (nor an
//     invoices_queue car-documents attachment, belt and braces);
//   • NEVER anything under `cars/` (the saved Xero sales-invoice PDFs), a
//     legacy multipart name, or any other shape, whatever its age;
//   • batched removes, capped per run;
//   • fail closed: a failed list or reference read removes nothing, answers
//     500 and does NOT stamp; a clean run (idle included) stamps.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import {
  GET, BUCKET, ORPHAN_MIN_AGE_HOURS, MAX_REMOVE_PER_RUN, REMOVE_CHUNK, HEARTBEAT_NAME,
} from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { makeCleanupDb } from '../../../../../tests/helpers/cleanup-fake-db'

const NOW = Date.parse('2026-10-02T04:25:00Z')
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000
const ago = (ms) => new Date(NOW - ms).toISOString()

const CAR = 'c0000000-0000-4000-8000-000000000001'
const CAR2 = 'c0000000-0000-4000-8000-000000000002'
const fileId = (n) => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`
const slot = (n, { car = CAR, type = 'other', ext = 'pdf' } = {}) => `${car}/${type}/${fileId(n)}.${ext}`

const obj = (name, ageMs = 48 * HOUR) => ({ name, created_at: ago(ageMs) })

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/sweep-car-document-orphans', { headers: { authorization: `Bearer ${secret}` } })

let db
function setup({ objects = [], carDocs = [], queue = [], errors = {}, storageErrors = {} } = {}) {
  db = makeCleanupDb({
    tables: {
      car_documents: carDocs.map((p, i) => ({ id: `doc-${i}`, car_id: CAR, storage_path: p })),
      invoices_queue: queue.map((q, i) => ({ id: `q-${i}`, attachment_bucket: q.bucket ?? BUCKET, attachment_path: q.path })),
    },
    errors,
    buckets: { [BUCKET]: objects },
    storageErrors,
  })
  createServerClient.mockImplementation(() => db)
  return db
}

const left = () => db.buckets[BUCKET].map((o) => o.name).sort()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})
afterEach(() => { vi.useRealTimers() })

describe('auth', () => {
  it('401s without the secret and touches nothing', async () => {
    setup({ objects: [obj(slot(1))] })
    expect((await GET(req('nope'))).status).toBe(401)
    expect(db.storageCalls).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    setup({ objects: [obj(slot(1))] })
    expect((await GET(req())).status).toBe(401)
    expect(db.storageCalls).toEqual([])
  })
})

describe('the constants', () => {
  it('sweeps the private car-documents bucket, 24 h minimum age, bounded batches', () => {
    expect(BUCKET).toBe('car-documents')
    expect(ORPHAN_MIN_AGE_HOURS).toBe(24)
    expect(REMOVE_CHUNK).toBeLessThanOrEqual(100)
    expect(MAX_REMOVE_PER_RUN).toBeLessThanOrEqual(1000)
    expect(HEARTBEAT_NAME).toBe('sweep-car-document-orphans')
  })
})

describe('what goes', () => {
  it('removes an unreferenced slot older than 24 h and keeps one just inside 24 h', async () => {
    setup({ objects: [obj(slot(1), 24 * HOUR + MIN), obj(slot(2), 24 * HOUR - MIN), obj(slot(3, { car: CAR2, type: 'nct_invoice', ext: 'jpg' }), 72 * HOUR)] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(db.removed.sort()).toEqual([slot(1), slot(3, { car: CAR2, type: 'nct_invoice', ext: 'jpg' })].sort())
    expect(left()).toEqual([slot(2)])
    const body = await res.json()
    expect(body.data).toMatchObject({ removed: 2, too_young: 1, orphans_found: 2 })
  })

  it('never removes an object car_documents.storage_path names, however old', async () => {
    setup({ objects: [obj(slot(1), 500 * HOUR), obj(slot(2), 500 * HOUR)], carDocs: [slot(1)] })
    await GET(req())
    expect(db.removed).toEqual([slot(2)])
    expect(left()).toEqual([slot(1)])
  })

  it('never removes an object an invoices_queue car-documents attachment names', async () => {
    setup({
      objects: [obj(slot(1)), obj(slot(2))],
      queue: [{ path: slot(1) }, { path: slot(2), bucket: 'inbound-invoices' }],
    })
    await GET(req())
    expect(db.removed).toEqual([slot(2)])
  })

  it('never touches cars/ (the Xero invoice PDFs), legacy multipart names, unknown doc types or other shapes', async () => {
    const untouchable = [
      `cars/${CAR}/xero-invoice-INV-1.pdf`,
      `cars/${CAR}/${fileId(9)}.pdf`,
      `cars/other/${fileId(9)}.pdf`,
      `${CAR}/other/1727000000000-abc123-invoice.pdf`,
      `${CAR}/receipts/${fileId(9)}.pdf`,
      `${CAR}/other/${fileId(9)}.exe`,
      `${CAR}/other/nested/${fileId(9)}.pdf`,
      `${CAR}/${fileId(9)}.pdf`,
      `${fileId(9)}.pdf`,
      `not-a-car/other/${fileId(9)}.pdf`,
      `${CAR}/other/.emptyFolderPlaceholder`,
    ]
    setup({ objects: [...untouchable.map((n) => obj(n, 5000 * HOUR)), obj(slot(1))] })
    const body = await (await GET(req())).json()
    expect(db.removed).toEqual([slot(1)])
    expect(left()).toEqual(untouchable.sort())
    // It never even lists inside cars/.
    expect(db.storageCalls.filter((c) => c.op === 'list').map((c) => c.prefix)).not.toContain('cars')
    expect(body.data.removed).toBe(1)
  })

  it('keeps an object whose created_at is missing or unreadable (never guesses its age)', async () => {
    setup({ objects: [{ name: slot(1), created_at: null }, { name: slot(2), created_at: 'not a date' }, obj(slot(3))] })
    await GET(req())
    expect(db.removed).toEqual([slot(3)])
  })

  it('every remove call names only paths it verified, in chunks', async () => {
    setup({ objects: [obj(slot(1)), obj(`cars/${CAR}/x.pdf`)] })
    await GET(req())
    const removes = db.storageCalls.filter((c) => c.op === 'remove')
    expect(removes).toHaveLength(1)
    expect(removes[0]).toMatchObject({ bucket: BUCKET, paths: [slot(1)] })
  })
})

describe('batching and paging', () => {
  it('removes at most MAX_REMOVE_PER_RUN per run, REMOVE_CHUNK per call, oldest first', async () => {
    const n = MAX_REMOVE_PER_RUN + 40
    const objects = Array.from({ length: n }, (_, i) => obj(slot(i + 1), (48 + i) * HOUR))
    setup({ objects })
    const body = await (await GET(req())).json()
    const removes = db.storageCalls.filter((c) => c.op === 'remove')
    for (const r of removes) expect(r.paths.length).toBeLessThanOrEqual(REMOVE_CHUNK)
    expect(db.removed).toHaveLength(MAX_REMOVE_PER_RUN)
    expect(body.data).toMatchObject({ removed: MAX_REMOVE_PER_RUN, cap_reached: true, orphans_found: n })
    // The 40 youngest orphans wait for tomorrow.
    expect(left()).toEqual(objects.slice(0, 40).map((o) => o.name).sort())
    expect(stampHeartbeat).toHaveBeenCalledWith(HEARTBEAT_NAME, expect.objectContaining({ cap_reached: true }))
  })

  it('pages each folder listing past the default page size', async () => {
    const objects = Array.from({ length: 250 }, (_, i) => obj(slot(i + 1)))
    setup({ objects, carDocs: objects.slice(0, 249).map((o) => o.name) })
    await GET(req())
    expect(db.removed).toEqual([slot(250)])
    const lists = db.storageCalls.filter((c) => c.op === 'list' && c.prefix === `${CAR}/other`)
    expect(lists.length).toBeGreaterThan(1)
  })

  it('chunks the reference reads so the .in() list stays short', async () => {
    const objects = Array.from({ length: 180 }, (_, i) => obj(slot(i + 1)))
    setup({ objects, carDocs: objects.map((o) => o.name) })
    await GET(req())
    expect(db.removed).toEqual([])
    const reads = db.calls.filter((c) => c.table === 'car_documents')
    expect(reads.length).toBeGreaterThan(1)
    for (const r of reads) expect(Math.max(...r.inSizes)).toBeLessThanOrEqual(50)
  })
})

describe('failure is closed', () => {
  it('a failed root list removes nothing, answers 500 and does NOT stamp', async () => {
    setup({ objects: [obj(slot(1))], storageErrors: { list: { message: 'storage down' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.removed).toEqual([])
    expect(db.storageCalls.filter((c) => c.op === 'remove')).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed list of ONE folder removes nothing anywhere', async () => {
    setup({
      objects: [obj(slot(1)), obj(slot(2, { car: CAR2 }))],
      storageErrors: { list: (prefix) => (prefix === `${CAR2}/other` ? { message: 'folder unreadable' } : null) },
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.removed).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed car_documents read removes nothing, answers 500 and does NOT stamp', async () => {
    setup({ objects: [obj(slot(1))], errors: { car_documents: { select: { message: 'db down' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.removed).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed invoices_queue read removes nothing, answers 500 and does NOT stamp', async () => {
    setup({ objects: [obj(slot(1))], errors: { invoices_queue: { select: { message: 'db down' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.removed).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed remove answers 500 and does NOT stamp', async () => {
    setup({ objects: [obj(slot(1))], storageErrors: { remove: { message: 'refused' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('heartbeat', () => {
  it('an idle run (nothing to sweep) stamps with counts only', async () => {
    setup({ objects: [obj(`cars/${CAR}/xero-invoice-1.pdf`), obj(slot(1))], carDocs: [slot(1)] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(db.removed).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    const [, outcome] = stampHeartbeat.mock.calls[0]
    expect(outcome).toMatchObject({ removed: 0, orphans_found: 0, referenced: 1, cap_reached: false })
    // Counts only: no path, name or id in the outcome.
    expect(JSON.stringify(outcome)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })
})
