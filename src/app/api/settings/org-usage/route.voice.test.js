import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/org-admin', () => ({ isOrgAdminSomewhere: vi.fn(), resolveAdminOrgId: vi.fn(() => ({ orgId: 'org-1' })) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/usage-summary', () => ({ getOrgUsageSummary: vi.fn() }))

import { PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { isOrgAdminSomewhere } from '@/lib/org-admin'
import { createServerClient } from '@/lib/supabase'

let upserts, selects
beforeEach(() => {
  vi.clearAllMocks()
  upserts = []; selects = []
  getCurrentUser.mockResolvedValue({ id: 'u-1' })
  isOrgAdminSomewhere.mockReturnValue(true)
  const single = (patch) => async () => ({
    data: { voice_transcription_enabled: patch.voice_transcription_enabled ?? false, voice_transcription_monthly_cap_minutes: patch.voice_transcription_monthly_cap_minutes ?? null },
    error: null,
  })
  const upsert = (patch) => {
    upserts.push(patch)
    return { select: (cols) => { selects.push(cols); return { single: single(patch) } } }
  }
  createServerClient.mockReturnValue({ from: () => ({ upsert }) })
})
const put = (body) => PUT(new Request('http://x/api/settings/org-usage', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

describe('PUT /api/settings/org-usage — voice transcription', () => {
  test('sets the switch and the cap, and returns them', async () => {
    const res = await put({ voice_transcription_enabled: true, voice_transcription_monthly_cap_minutes: 60 })
    expect(res.status).toBe(200)
    expect(upserts[0]).toMatchObject({ organization_id: 'org-1', voice_transcription_enabled: true, voice_transcription_monthly_cap_minutes: 60 })
    expect(selects[0]).toContain('voice_transcription_enabled')
    expect(selects[0]).toContain('voice_transcription_monthly_cap_minutes')
    const json = await res.json()
    expect(json.data).toMatchObject({ voice_transcription_enabled: true, voice_transcription_monthly_cap_minutes: 60 })
  })
  test('patches only the keys present', async () => {
    await put({ voice_transcription_enabled: false })
    expect(upserts[0]).toHaveProperty('voice_transcription_enabled', false)
    expect(upserts[0]).not.toHaveProperty('voice_transcription_monthly_cap_minutes')
    expect(upserts[0]).not.toHaveProperty('ai_hard_cap_cents')
    await put({ voice_transcription_monthly_cap_minutes: null })
    expect(upserts[1]).toHaveProperty('voice_transcription_monthly_cap_minutes', null)
    expect(upserts[1]).not.toHaveProperty('voice_transcription_enabled')
  })
  test('a zero, negative or fractional cap is refused', async () => {
    for (const v of [0, -5, 1.5]) expect((await put({ voice_transcription_monthly_cap_minutes: v })).status).toBe(400)
    expect(upserts).toHaveLength(0)
  })
  test('a non-org-admin is refused', async () => {
    isOrgAdminSomewhere.mockReturnValue(false)
    expect((await put({ voice_transcription_enabled: true })).status).toBe(403)
    expect(upserts).toHaveLength(0)
  })
})

describe('PUT /api/settings/org-usage — voice replies', () => {
  test('sets mode, test numbers and cap, and returns them', async () => {
    const res = await put({ voice_reply_mode: 'test', voice_reply_test_phones: ['+353 87 123 4567'], voice_reply_monthly_cap: 50 })
    expect(res.status).toBe(200)
    expect(upserts[0]).toMatchObject({ voice_reply_mode: 'test', voice_reply_test_phones: ['+353 87 123 4567'], voice_reply_monthly_cap: 50 })
    for (const col of ['voice_reply_mode', 'voice_reply_test_phones', 'voice_reply_monthly_cap']) expect(selects[0]).toContain(col)
  })
  test('an unknown mode, a zero cap or too many numbers is refused', async () => {
    expect((await put({ voice_reply_mode: 'maybe' })).status).toBe(400)
    expect((await put({ voice_reply_monthly_cap: 0 })).status).toBe(400)
    expect((await put({ voice_reply_test_phones: Array(21).fill('1') })).status).toBe(400)
    expect(upserts).toHaveLength(0)
  })
  test('only the keys sent change', async () => {
    await put({ voice_reply_mode: 'on' })
    expect(upserts[0]).not.toHaveProperty('voice_reply_test_phones')
    expect(upserts[0]).not.toHaveProperty('voice_reply_monthly_cap')
  })
})
