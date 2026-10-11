// route.tz.test.js — TZ.5. The staff assistant's "Today" is the active
// location's day, not Dublin's. The Dublin byte-identity sweep ran in TZ.5 and
// was retired in TZ.18b: Europe/Dublin is pinned by fixed values below, and
// zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/usage', () => ({ recordUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/anthropic', () => ({
  anthropicMessages: vi.fn(async () => ({
    res: { ok: true },
    data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  })),
}))

const { POST } = await import('./route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { anthropicMessages } = await import('@/lib/anthropic')

const userAt = (timezone) => ({
  id: 'u1', full_name: 'Test Manager', role: 'manager', permissions: {},
  activeLocation: { id: 'loc1', name: 'Studio', timezone },
})
const todayLine = async () => {
  await POST(new Request('http://localhost/api/assistant/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Who is on today?' }] }),
  }))
  const system = anthropicMessages.mock.calls.at(-1)[0].system
  return system.map((b) => b.text).join('\n').match(/- Today: (.*)/)[1]
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => { vi.useRealTimers() })

describe('TZ.5 Europe/Dublin pinned values', () => {
  it.each([
    ['2026-03-28T23:30:00Z', '2026-03-28'], // 23:30 GMT, eve of the spring-forward
    ['2026-03-29T23:30:00Z', '2026-03-30'], // 00:30 IST, after it
    ['2026-07-01T23:30:00Z', '2026-07-02'], // summer: 00:30 IST
    ['2026-10-24T23:30:00Z', '2026-10-25'], // 00:30 IST, before the fall-back
    ['2026-10-25T23:30:00Z', '2026-10-25'], // 23:30 GMT, after it
    ['2026-12-31T23:30:00Z', '2026-12-31'], // winter: 23:30 GMT
  ])('%s -> %s', async (iso, day) => {
    vi.setSystemTime(new Date(iso))
    getCurrentUser.mockResolvedValue(userAt('Europe/Dublin'))
    expect(await todayLine()).toBe(day)
    getCurrentUser.mockResolvedValue(userAt(null)) // a NULL column is Dublin
    expect(await todayLine()).toBe(day)
  })
})

describe('TZ.5 America/New_York follows New York across DST', () => {
  it('"Today" flips at New York midnight', async () => {
    getCurrentUser.mockResolvedValue(userAt('America/New_York'))
    vi.setSystemTime(new Date('2026-07-02T03:59:00Z')) // 23:59 EDT on the 1st
    expect(await todayLine()).toBe('2026-07-01')
    vi.setSystemTime(new Date('2026-07-02T04:00:00Z'))
    expect(await todayLine()).toBe('2026-07-02')
    vi.setSystemTime(new Date('2026-11-02T04:59:00Z')) // 23:59 EST on the 1st
    expect(await todayLine()).toBe('2026-11-01')
    vi.setSystemTime(new Date('2026-11-02T05:00:00Z'))
    expect(await todayLine()).toBe('2026-11-02')
  })
})
