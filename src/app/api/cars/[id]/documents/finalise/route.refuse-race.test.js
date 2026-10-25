// CARDOCREFUSERACE.1 (C136) — a refused finalise must never delete an object
// another call has already recorded.
//
// The race: two finalise calls on ONE slot. Call A declares the right type and
// records its car_documents row; call B declares a mismatched type, passed the
// existing-row read before A's insert landed, and reaches refuse(), which used
// to remove the stored object: A's row then pointed at nothing. refuse() now
// re-reads car_documents for the slot before removing anything.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccessOr404: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true), hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromCarDocument: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import { POST } from './route.js'

const CAR = { id: 'c0000000-0000-0000-0000-000000000001', location_id: 'a0000000-0000-0000-0000-00000000000a' }
const SLOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SLOT = `${CAR.id}/other/${SLOT_ID}.pdf`
const MB = 1024 * 1024

let calls
/**
 * reads: one answer per car_documents read, in order ({ data, error }); the
 * first is the route's existing-row check, the second refuse()'s re-check.
 * stored: what Storage holds at the slot.
 */
function fakeDb({ reads, stored = { size: 2 * MB, mimetype: 'image/png' } }) {
  calls = { remove: [], reads: [], inserted: null }
  let i = 0
  const bucket = {
    list: vi.fn(async (folder, opts) => ({ data: [{ name: opts.search, metadata: { size: stored.size, mimetype: stored.mimetype } }], error: null })),
    download: vi.fn(async () => ({ data: new Blob([Buffer.from('%PDF-1.7')]), error: null })),
    remove: vi.fn(async (paths) => { calls.remove.push(paths); return { data: [], error: null } }),
  }
  return {
    from: (table) => {
      if (table === 'cars') return { select: () => ({ eq: () => ({ single: async () => ({ data: CAR, error: null }) }) }) }
      if (table === 'car_documents') {
        return {
          select: (cols) => {
            const chain = []
            const q = {
              eq: (c, v) => { chain.push([c, v]); return q },
              limit: async (n) => {
                calls.reads.push({ cols, chain, n })
                const answer = reads[i] ?? reads[reads.length - 1]
                i += 1
                return answer
              },
            }
            return q
          },
          insert: (row) => {
            calls.inserted = row
            return { select: () => ({ single: async () => ({ data: { id: 'd1', ...row }, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: { from: vi.fn(() => bucket) },
  }
}

const finalise = (body) => POST(
  new Request('http://localhost/api/cars/x/documents/finalise', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: CAR.id }) },
)
// Storage holds a PNG under a .pdf slot: the declared PDF does not match, so
// this call refuses (MISMATCH).
const mismatched = { doc_type: 'other', path: SLOT, file_name: 'Invoice.pdf', mime: 'application/pdf' }
const NONE = { data: [], error: null }
const RECORDED = { data: [{ id: 'd0' }], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: CAR.location_id }] })
})

describe('finalise refuse() and a racing recorded row (C136)', () => {
  it('keeps the object and answers 409 when another call recorded the slot after the first check', async () => {
    createServerClient.mockReturnValue(fakeDb({ reads: [NONE, RECORDED] }))
    const res = await finalise(mismatched)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'This upload is already saved.' })
    expect(calls.remove).toEqual([])
    expect(calls.inserted).toBeNull()
    // The re-check is the slot's own row on this car.
    expect(calls.reads).toHaveLength(2)
    expect(calls.reads[1].chain).toEqual([['car_id', CAR.id], ['storage_path', SLOT]])
  })

  it('keeps the object when the re-check cannot be read (a missing file is worse than an orphan) and still refuses', async () => {
    createServerClient.mockReturnValue(fakeDb({ reads: [NONE, { data: null, error: { message: 'connection reset' } }] }))
    const res = await finalise(mismatched)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("The uploaded file's type does not match. Pick it again.")
    expect(calls.remove).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('car-documents-upload', 'refused document kept: recorded-row re-check failed', { error: 'connection reset' })
  })

  it('removes the object as before when no row holds the slot', async () => {
    createServerClient.mockReturnValue(fakeDb({ reads: [NONE, NONE] }))
    const res = await finalise(mismatched)
    expect(res.status).toBe(400)
    expect(calls.remove).toEqual([[SLOT]])
    expect(calls.reads).toHaveLength(2)
  })

  it('re-checks before every kind of refusal (a size refusal too)', async () => {
    createServerClient.mockReturnValue(fakeDb({ reads: [NONE, RECORDED], stored: { size: 0, mimetype: 'application/pdf' } }))
    const res = await finalise({ ...mismatched, mime: 'application/pdf' })
    expect(res.status).toBe(409)
    expect(calls.remove).toEqual([])
  })

  it('a good upload makes no second read', async () => {
    createServerClient.mockReturnValue(fakeDb({ reads: [NONE], stored: { size: 2 * MB, mimetype: 'application/pdf' } }))
    const res = await finalise({ ...mismatched, mime: 'application/pdf' })
    expect(res.status).toBe(201)
    expect(calls.reads).toHaveLength(1)
    expect(calls.remove).toEqual([])
  })
})
