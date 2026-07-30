import { describe, it, expect, vi } from 'vitest'
import { ensureHostSlug } from './hosts'

// Minimal supabase-shaped mock: db.from('event_hosts').update({slug}).eq('id', X)
// resolves { error } — ensureHostSlug retries with -2, -3… suffixes on 23505.
function mockDb(errorsInOrder) {
  const updates = []
  let call = 0
  const db = {
    from: vi.fn(() => ({
      update: vi.fn((patch) => ({
        eq: vi.fn(async () => {
          updates.push(patch.slug)
          const error = errorsInOrder[call] || null
          call += 1
          return { error }
        }),
      })),
    })),
  }
  return { db, updates }
}

describe('ensureHostSlug', () => {
  it('returns the existing slug without writing', async () => {
    const { db } = mockDb([])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: 'acme' })
    expect(slug).toBe('acme')
    expect(db.from).not.toHaveBeenCalled()
  })

  it('derives from the name and persists', async () => {
    const { db, updates } = mockDb([null])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Pride Training Club', slug: null })
    expect(slug).toBe('pride-training-club')
    expect(updates).toEqual(['pride-training-club'])
  })

  it('suffixes on unique violation', async () => {
    const { db, updates } = mockDb([{ code: '23505' }, null])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: null })
    expect(slug).toBe('acme-2')
    expect(updates).toEqual(['acme', 'acme-2'])
  })

  it('throws on a non-unique-violation error', async () => {
    const { db } = mockDb([{ code: '42501', message: 'nope' }])
    await expect(ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: null })).rejects.toThrow(/slug persist failed/)
  })
})
