// src/lib/studio-session-mint.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
const { createClient } = await import('@supabase/supabase-js')
const { mintSupabaseSession } = await import('./studio-session-mint.js')

function makeAdmin({ email = 'alice@un1t.ie', hashed_token = 'hash-123' } = {}) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email } }, error: null })),
        generateLink: vi.fn(async () => ({ data: { properties: { hashed_token } }, error: null })),
      },
    },
  }
}

beforeEach(() => {
  createClient.mockReset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
})

describe('mintSupabaseSession', () => {
  it('returns access+refresh tokens on the happy path', async () => {
    const anon = { auth: { verifyOtp: vi.fn(async () => ({
      data: { session: { access_token: 'at-1', refresh_token: 'rt-1' } }, error: null,
    })) } }
    createClient.mockReturnValue(anon)
    const admin = makeAdmin()

    const out = await mintSupabaseSession({ admin, profileId: 'p-1' })
    expect(out).toEqual({ access_token: 'at-1', refresh_token: 'rt-1' })
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith('p-1')
    expect(admin.auth.admin.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'alice@un1t.ie' })
    expect(anon.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-123', type: 'magiclink' })
  })

  it('throws when the auth email cannot be resolved', async () => {
    const admin = makeAdmin()
    admin.auth.admin.getUserById = vi.fn(async () => ({ data: { user: null }, error: null }))
    await expect(mintSupabaseSession({ admin, profileId: 'p-1' })).rejects.toThrow(/auth email/)
  })

  it('throws when verifyOtp returns no session', async () => {
    const anon = { auth: { verifyOtp: vi.fn(async () => ({ data: { session: null }, error: null })) } }
    createClient.mockReturnValue(anon)
    await expect(mintSupabaseSession({ admin: makeAdmin(), profileId: 'p-1' })).rejects.toThrow(/no session/)
  })

  it('throws when profileId is missing', async () => {
    await expect(mintSupabaseSession({ admin: makeAdmin(), profileId: '' })).rejects.toThrow(/profileId/)
  })
})
