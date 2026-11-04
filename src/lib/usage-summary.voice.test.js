import { test, expect, vi } from 'vitest'
import { getOrgUsageSummary } from './usage-summary.js'

function db({ settings, rows = [], eventsError = null }) {
  const from = vi.fn((table) => {
    const q = {
      select: () => q, eq: () => q, gte: () => q, lt: () => q, lte: () => q, in: () => q, order: () => q,
      maybeSingle: async () => ({ data: table === 'org_settings' ? settings : null, error: null }),
      range: async (a, b) => (table === 'usage_events'
        ? (eventsError ? { data: null, error: eventsError } : { data: rows.slice(a, b + 1), error: null })
        : { data: [], error: null }),
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
    }
    return q
  })
  return { from, rpc: vi.fn(async () => ({ data: 0, error: null })) }
}

test('the summary carries the voice switch, cap and minutes used (rounded up)', async () => {
  const d = db({ settings: { voice_transcription_enabled: true, voice_transcription_monthly_cap_minutes: 30 }, rows: [{ quantity: 61 }, { quantity: 30 }] })
  const s = await getOrgUsageSummary(d, 'org-1')
  expect(s.voice).toEqual({ enabled: true, capMinutes: 30, usedMinutes: 2 })
})

test('defaults when nothing is set; unreadable usage is null, not zero', async () => {
  expect((await getOrgUsageSummary(db({ settings: null }), 'org-1')).voice).toEqual({ enabled: false, capMinutes: null, usedMinutes: 0 })
  expect((await getOrgUsageSummary(db({ settings: null, eventsError: { message: 'x' } }), 'org-1')).voice.usedMinutes).toBeNull()
})
