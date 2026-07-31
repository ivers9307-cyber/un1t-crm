// Coverage for POST /api/mobile/device-tokens — the Expo push-token
// registration endpoint. The app_version cases matter beyond input
// hygiene: whatever lands in that column is what STAFF-DEV's
// deriveTargetVersion() measures the whole fleet against, so a device
// must not be able to claim an arbitrarily high version.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

const TOKEN = 'ExponentPushToken[abcdef123456]'

// Captures the upserted row so assertions can read what was written.
function makeDb(captured) {
  return {
    from: () => ({
      upsert(row) {
        captured.row = row
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'dt-1' }, error: null }),
          }),
        }
      },
    }),
  }
}

const req = (body) =>
  new Request('http://localhost/api/mobile/device-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/mobile/device-tokens', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ expo_push_token: TOKEN }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('registers a device with a well-formed app_version', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({
      expo_push_token: TOKEN, platform: 'ios',
      device_name: 'iPhone 15', app_version: '2.2.0',
    }))
    expect(res.status).toBe(200)
    expect(captured.row.app_version).toBe('2.2.0')
    expect(captured.row.user_id).toBe('u1')
  })

  it('400s on a malformed app_version instead of storing it', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    for (const bad of ['9'.repeat(40), '99999.0.0', 'not-a-version', '2.2.0; DROP', '']) {
      const res = await POST(req({ expo_push_token: TOKEN, app_version: bad }))
      expect(res.status, `expected 400 for ${JSON.stringify(bad)}`).toBe(400)
    }
    expect(captured.row).toBeUndefined()
  })

  it('still accepts a register with no app_version at all (old clients)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    const captured = {}
    createServerClient.mockReturnValue(makeDb(captured))

    const res = await POST(req({ expo_push_token: TOKEN }))
    expect(res.status).toBe(200)
    expect(captured.row.app_version).toBeUndefined()
  })
})
