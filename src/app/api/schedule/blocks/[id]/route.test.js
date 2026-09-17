// SLOTREMOVAL.1 — DELETE /api/schedule/blocks/[id] remembers the removal.
//
// The nightly horizon generator upserts every date a template runs, so a
// deleted block used to be back by morning. The delete now writes a
// shift_block_removals row, which the generator and roster copies skip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn((user) => (user.locations || []).map((l) => l.id)),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logWarn } = await import('@/lib/log')
const { DELETE } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BLOCK = { id: 'blk-1', location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-15' }

function makeDb({ block = BLOCK, deleteError = null, removalError = null } = {}) {
  const captured = { deleted: null, removal: null, removalOpts: null, order: [] }
  const db = {
    captured,
    from(table) {
      if (table === 'shift_blocks') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve(block ? { data: block, error: null } : { data: null, error: { message: 'no rows' } }) }) }),
          delete: () => ({
            eq: (col, val) => {
              captured.deleted = [col, val]
              captured.order.push('delete')
              return Promise.resolve({ data: null, error: deleteError })
            },
          }),
        }
      }
      if (table === 'shift_block_removals') {
        return {
          upsert: (row, opts) => {
            captured.removal = row
            captured.removalOpts = opts
            captured.order.push('removal')
            return Promise.resolve({ data: null, error: removalError })
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const params = { params: Promise.resolve({ id: 'blk-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC }] })
})

describe('DELETE /api/schedule/blocks/[id] — SLOTREMOVAL.1', () => {
  it('deletes the block, then records the removal for its location, template and date', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.captured.deleted).toEqual(['id', 'blk-1'])
    expect(db.captured.order).toEqual(['delete', 'removal'])
    expect(db.captured.removal).toEqual({
      location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-15', removed_by: 'mgr-1',
    })
    expect(db.captured.removalOpts).toEqual({ onConflict: 'location_id,template_id,block_date', ignoreDuplicates: true })
  })

  it('still reports success, with a warning, when the removal write fails (the block is gone either way)', async () => {
    const db = makeDb({ removalError: { message: 'removal boom' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.warning).toMatch(/nightly schedule may add it back/)
    expect(db.captured.deleted).toEqual(['id', 'blk-1'])
    expect(logWarn).toHaveBeenCalledWith('schedule-blocks', expect.any(String), expect.objectContaining({ blockId: 'blk-1' }))
  })

  it('records no removal when the delete itself fails', async () => {
    const db = makeDb({ deleteError: { message: 'fk boom' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    expect(res.status).toBe(400)
    expect(db.captured.removal).toBeNull()
  })

  it('404s an unknown block and 403s another location\'s block, writing nothing', async () => {
    let db = makeDb({ block: null })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(404)
    expect(db.captured.order).toEqual([])

    db = makeDb({ block: { ...BLOCK, location_id: 'other-loc' } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(403)
    expect(db.captured.order).toEqual([])
  })

  it('403s a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 's', role: 'staff', locations: [{ id: LOC }] })
    createServerClient.mockReturnValue(makeDb())
    expect((await DELETE({}, params)).status).toBe(403)
  })
})
