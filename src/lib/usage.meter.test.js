import { test, expect, vi } from 'vitest'
import { recordMeterUsage } from './usage.js'

function db(result = { error: null }) {
  const inserts = []
  return { inserts, from: vi.fn(() => ({ insert: vi.fn(async (row) => { inserts.push(row); return result }) })) }
}

test('recordMeterUsage writes one usage_events row', async () => {
  const d = db()
  await recordMeterUsage({ organizationId: 'org-1', locationId: 'loc-1', meter: 'elevenlabs_stt_seconds', source: 'wa_voice_note', quantity: 42, costCents: 1.5, meta: { model: 'scribe_v2' } }, { db: d })
  expect(d.from).toHaveBeenCalledWith('usage_events')
  expect(d.inserts).toEqual([{ organization_id: 'org-1', location_id: 'loc-1', meter: 'elevenlabs_stt_seconds', source: 'wa_voice_note', quantity: 42, cost_estimate_cents: 1.5, meta: { model: 'scribe_v2' } }])
})

test('a failed insert or a thrown client never throws', async () => {
  await expect(recordMeterUsage({ meter: 'm', source: 's', quantity: 1 }, { db: db({ error: { message: 'x' } }) })).resolves.toBeUndefined()
  const broken = { from: () => { throw new Error('boom') } }
  await expect(recordMeterUsage({ meter: 'm', source: 's', quantity: 1 }, { db: broken })).resolves.toBeUndefined()
})
