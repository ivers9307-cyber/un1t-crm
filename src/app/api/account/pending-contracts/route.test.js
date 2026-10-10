// W1.S2 — /api/account/pending-contracts carries the ISSUER of each pending
// contract (the contracting entity frozen on the document at issue,
// LEGALENT.1) so the global alert can name it. A presence assertion, not just
// the absence of a literal: a blank label would pass the literal sweep guard
// and render "needs your signature" with nobody in front of it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { LEGACY_COUNTERSIGNATURE_ENTITY } from '@/lib/contracting-entity'

function dbWith(rows) {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    in: vi.fn(() => q),
    order: vi.fn(async () => ({ data: rows, error: null })),
  }
  return { from: vi.fn(() => q), _q: q }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1' })
})

describe('GET /api/account/pending-contracts — issuer', () => {
  it('names the entity frozen on the document, and the legacy entity for a row with none', async () => {
    createServerClient.mockReturnValue(dbWith([
      { id: 'c1', status: 'issued', issued_at: '2026-10-01', variables_data: { legal_entity_name: 'Example Fitness Ltd (trading as Example Gym)' }, template: { name: 'Coach FTE' } },
      { id: 'c2', status: 'viewed', issued_at: '2026-09-01', variables_data: {}, template: null },
    ]))
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data[0]).toMatchObject({ id: 'c1', template_name: 'Coach FTE', issuer: 'Example Fitness Ltd (trading as Example Gym)' })
    expect(body.data[1].issuer).toBe(LEGACY_COUNTERSIGNATURE_ENTITY)
    for (const row of body.data) expect(row.issuer.trim().length).toBeGreaterThan(0)
  })

  it('reads variables_data for the label (the select names it)', async () => {
    const db = dbWith([])
    createServerClient.mockReturnValue(db)
    await GET()
    expect(db._q.select.mock.calls[0][0]).toMatch(/variables_data/)
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })
})
