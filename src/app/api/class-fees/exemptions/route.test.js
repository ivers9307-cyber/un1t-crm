// ROUTEWRAP.R10 — /api/class-fees/exemptions through the real withAuth wrapper:
// signed out is the wrapper's 401 (before the input is read), the studio check
// and class_fees there run in their old order, and the list/add/remove reach
// the shared helpers for that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-exemptions', () => ({
  listExemptions: vi.fn(async () => [{ contact_id: 'x' }]),
  addExemption: vi.fn(async () => ({ ok: true, waived: 2 })),
  removeExemption: vi.fn(async () => ({ removed: true })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { listExemptions, addExemption, removeExemption } = await import('@/lib/class-fees-exemptions')
const { GET, POST, DELETE } = await import('./route.js')

const CONTACT = 'c0000000-0000-4000-8000-0000000000c1'
const url = 'http://localhost/api/class-fees/exemptions'
const get = (loc = LOC_A) => GET(new Request(`${url}?location_id=${loc}`))
const send = (fn, method, body) => fn(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const fees = (on = true) => person({ [LOC_A]: { role: 'manager', permissions: { class_fees: on } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/api/class-fees/exemptions', () => {
  it('401 signed out on every method, even with bad input', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await get('nope'), await send(POST, 'POST', {}), await send(DELETE, 'DELETE', {})]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
  })

  it('400 for a signed-in caller with bad input, before the studio check', async () => {
    getCurrentUser.mockResolvedValue(fees())
    expect((await get('nope')).status).toBe(400)
    expect((await send(POST, 'POST', { location_id: LOC_A })).status).toBe(400)
  })

  it('403 at a studio outside the caller’s, and without class_fees', async () => {
    getCurrentUser.mockResolvedValue(fees())
    expect((await get(LOC_B)).status).toBe(403)
    expect((await send(POST, 'POST', { location_id: LOC_B, contact_id: CONTACT })).status).toBe(403)
    getCurrentUser.mockResolvedValue(fees(false))
    const res = await send(DELETE, 'DELETE', { location_id: LOC_A, contact_id: CONTACT })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(addExemption).not.toHaveBeenCalled()
    expect(removeExemption).not.toHaveBeenCalled()
  })

  it('lists, adds and removes at the caller’s studio', async () => {
    getCurrentUser.mockResolvedValue(fees())
    expect((await (await get()).json()).data.rows).toHaveLength(1)
    expect(listExemptions).toHaveBeenCalledWith({ tag: 'db' }, LOC_A)
    expect((await (await send(POST, 'POST', { location_id: LOC_A, contact_id: CONTACT })).json()).data).toEqual({ exempt: true, waived: 2 })
    expect(addExemption).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_A, contactId: CONTACT, note: undefined, actorId: 'user-1' })
    expect((await send(DELETE, 'DELETE', { location_id: LOC_A, contact_id: CONTACT })).status).toBe(200)
    expect(removeExemption).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_A, contactId: CONTACT })
  })

  it('a contact outside the studio’s organisation is 404', async () => {
    getCurrentUser.mockResolvedValue(fees())
    addExemption.mockResolvedValueOnce({ ok: false })
    expect((await send(POST, 'POST', { location_id: LOC_A, contact_id: CONTACT })).status).toBe(404)
  })
})
