// HYROX-TC.2 — POST /api/hyrox/blocks through the real withAuth wrapper: body
// 400, then the Hyrox approvals grant AT the body's studio, then the block.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/hyrox/generate-block', () => ({ createBlockWithArc: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { createBlockWithArc } = await import('@/lib/hyrox/generate-block')
const { POST } = await import('./route.js')

const KEY = 'approvals_hyrox_sessions'
const body = (loc = LOC_B) => ({ location_id: loc, starts_on: '2026-12-07', session_weekdays: [1, 3, 5] })
const post = (b) => POST(new Request('http://localhost/api/hyrox/blocks', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}))
const keyAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { [KEY]: a } }, [LOC_B]: { role: 'manager', permissions: { [KEY]: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { locations: [{ id: LOC_B, name: 'Studio B', settings: {} }] } }))
  createBlockWithArc.mockResolvedValue({ ok: true, block: { id: 'blk-1' } })
})

describe('POST /api/hyrox/blocks', () => {
  it('401 signed out, nothing generated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(body())).status).toBe(401)
    expect(createBlockWithArc).not.toHaveBeenCalled()
  })

  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({ location_id: LOC_B })).status).toBe(400)
  })

  it('403 without the grant at the body\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await post(body())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(createBlockWithArc).not.toHaveBeenCalled()
  })

  it('a caller with the grant there creates the block', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await post(body())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, data: { block: { id: 'blk-1' }, sessionsCreated: 0 } })
    expect(createBlockWithArc.mock.calls[0][1].input).toMatchObject({ location_id: LOC_B, created_by: 'user-1' })
  })

  it('a fixed failure code passes through; database text does not', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    createBlockWithArc.mockResolvedValueOnce({ ok: false, error: 'arc_generation_failed' })
    let res = await post(body())
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('arc_generation_failed')
    createBlockWithArc.mockResolvedValueOnce({ ok: false, error: 'duplicate key value violates hyrox_blocks_pkey' })
    res = await post(body())
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('block_insert_failed')
  })
})
