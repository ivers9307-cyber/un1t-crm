import { test, expect, vi } from 'vitest'
import { getVoiceCapStatus, platformMonthStartStr } from './usage-caps.js'
import { zonedWallClockToInstant, PLATFORM_TZ } from '@/lib/location-time'

function stubDb({ cap = 10, settingsError = null, rows = [], eventsError = null } = {}) {
  const filters = []
  const db = {
    from: vi.fn((table) => {
      if (table === 'org_settings') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settingsError ? null : { voice_transcription_monthly_cap_minutes: cap }, error: settingsError }) }) }) }
      }
      if (table === 'usage_events') {
        const q = {
          select: (cols) => { filters.push(['select', cols]); return q },
          eq: (c, v) => { filters.push(['eq', c, v]); return q },
          gte: (c, v) => { filters.push(['gte', c, v]); return q },
          order: (c) => { filters.push(['order', c]); return q },
          range: async (from, to) => {
            filters.push(['range', from, to])
            if (eventsError) return { data: null, error: eventsError }
            return { data: rows.slice(from, to + 1), error: null }
          },
        }
        return q
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, filters }
}

test('no cap → not capped, but usage is still counted for the settings line', async () => {
  const { db } = stubDb({ cap: null })
  expect(await getVoiceCapStatus({ organizationId: 'org-1' }, { db })).toEqual({ capped: false, capMinutes: null, usedSeconds: 0 })
})

test('600 s used against a 10 minute cap is capped; 599 is not', async () => {
  expect((await getVoiceCapStatus({ organizationId: 'org-1' }, { db: stubDb({ rows: [{ quantity: 300 }, { quantity: 300 }] }).db })))
    .toEqual({ capped: true, capMinutes: 10, usedSeconds: 600 })
  expect((await getVoiceCapStatus({ organizationId: 'org-1' }, { db: stubDb({ rows: [{ quantity: 599 }] }).db })).capped).toBe(false)
})

test('reads only this org, this meter, this platform month, paged', async () => {
  const { db, filters } = stubDb({ rows: [] })
  await getVoiceCapStatus({ organizationId: 'org-1' }, { db })
  expect(filters).toContainEqual(['eq', 'meter', 'elevenlabs_stt_seconds'])
  expect(filters).toContainEqual(['eq', 'organization_id', 'org-1'])
  const monthStart = new Date(zonedWallClockToInstant(platformMonthStartStr(), '00:00', PLATFORM_TZ)).toISOString()
  expect(filters).toContainEqual(['gte', 'occurred_at', monthStart])
  expect(filters.some((f) => f[0] === 'order')).toBe(true)
  expect(filters.some((f) => f[0] === 'range')).toBe(true)
})

test('pages past 1000 rows', async () => {
  const rows = Array.from({ length: 1500 }, () => ({ quantity: 1 }))
  expect((await getVoiceCapStatus({ organizationId: 'org-1' }, { db: stubDb({ cap: 100, rows }).db })).usedSeconds).toBe(1500)
})

test('read errors fail open', async () => {
  expect((await getVoiceCapStatus({ organizationId: 'org-1' }, { db: stubDb({ settingsError: { message: 'x' } }).db })).capped).toBe(false)
  expect((await getVoiceCapStatus({ organizationId: 'org-1' }, { db: stubDb({ eventsError: { message: 'x' } }).db })).capped).toBe(false)
  expect((await getVoiceCapStatus({ organizationId: null }, { db: stubDb().db })).capped).toBe(false)
})

import { getVoiceReplyCapStatus } from './usage-caps.js'
function replyDb({ cap = 3, rows = [], settingsError = null, eventsError = null } = {}) {
  const filters = []
  return {
    filters,
    from: (table) => {
      if (table === 'org_settings') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settingsError ? null : { voice_reply_monthly_cap: cap }, error: settingsError }) }) }) }
      const q = {
        select: () => q, eq: (c, v) => { filters.push([c, v]); return q }, gte: () => q, order: () => q,
        range: async (a, b) => (eventsError ? { data: null, error: eventsError } : { data: rows.slice(a, b + 1), error: null }),
      }
      return q
    },
  }
}
test('voice reply cap: counts replies this month and fails open', async () => {
  expect(await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: replyDb({ rows: [{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }] }) })).toEqual({ capped: true, cap: 3, used: 3 })
  expect((await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: replyDb({ rows: [{ quantity: 1 }, { quantity: 1 }] }) })).capped).toBe(false)
  const d = replyDb()
  await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: d })
  expect(d.filters).toContainEqual(['meter', 'elevenlabs_tts_replies'])
  expect((await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: replyDb({ settingsError: { message: 'x' } }) })).capped).toBe(false)
  expect((await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: replyDb({ eventsError: { message: 'x' } }) })).capped).toBe(false)
  expect(await getVoiceReplyCapStatus({ organizationId: 'o' }, { db: replyDb({ cap: null }) })).toEqual({ capped: false, cap: null, used: 0 })
})
