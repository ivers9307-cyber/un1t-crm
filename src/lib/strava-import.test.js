import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./strava.js', () => ({
  refreshAccessToken: vi.fn(),
  getActivity: vi.fn(),
  listActivities: vi.fn(),
}))
import { ensureFreshToken } from './strava-import.js'
import { refreshAccessToken } from './strava.js'

beforeEach(() => vi.clearAllMocks())

function dbWithUpdateCapture(captured) {
  return { from: () => ({ update: (p) => { captured.payload = p; const c = { eq: () => c }; c.then = (r) => r({ error: null }); return c } }) }
}

const CONFIG = { clientId: 'cid', clientSecret: 'sec' }

describe('ensureFreshToken', () => {
  it('returns the current token when not near expiry', async () => {
    const conn = { id: 'x', access_token: 'live', refresh_token: 'r', expires_at: new Date(Date.now() + 3600_000).toISOString() }
    const token = await ensureFreshToken({ from: () => ({}) }, conn, CONFIG)
    expect(token).toBe('live')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
  it('refreshes + persists when expired', async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00Z' })
    const captured = {}
    const conn = { id: 'x', access_token: 'old', refresh_token: 'r', expires_at: new Date(Date.now() - 1000).toISOString() }
    const token = await ensureFreshToken(dbWithUpdateCapture(captured), conn, CONFIG)
    expect(token).toBe('fresh')
    expect(refreshAccessToken).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'r' })
    expect(captured.payload).toMatchObject({ access_token: 'fresh', refresh_token: 'r2', expires_at: '2030-01-01T00:00:00Z' })
  })
})
