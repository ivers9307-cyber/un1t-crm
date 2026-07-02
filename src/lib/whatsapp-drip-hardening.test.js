import { describe, it, expect, vi } from 'vitest'
import { isFrequencyCapError, fetchDripDoneContactIds, CAPPED_RETRY_HOURS } from './whatsapp.js'
import { applyMetaUserPreference } from './whatsapp-consent.js'

describe('isFrequencyCapError', () => {
  it('matches code 131049 and the healthy-ecosystem message', () => {
    expect(isFrequencyCapError({ code: 131049 })).toBe(true)
    expect(isFrequencyCapError({ message: 'This message was not delivered to maintain healthy ecosystem engagement.' })).toBe(true)
  })
  it('does not match undeliverable or generic failures', () => {
    expect(isFrequencyCapError({ code: 131026, message: 'Message undeliverable' })).toBe(false)
    expect(isFrequencyCapError({ message: 'Template paused' })).toBe(false)
    expect(isFrequencyCapError({})).toBe(false)
  })
})

function pagedDb(rows) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            range: (start, end) => Promise.resolve({ data: rows.slice(start, end + 1), error: null }),
          }),
        }),
      }),
    }),
  }
}

describe('fetchDripDoneContactIds — capped retry window', () => {
  const OLD = new Date(Date.now() - (CAPPED_RETRY_HOURS + 2) * 3600 * 1000).toISOString()
  const FRESH = new Date(Date.now() - 1 * 3600 * 1000).toISOString()

  it('sent/failed rows are done; expired capped rows re-open; fresh capped stay done', async () => {
    const db = pagedDb([
      { contact_id: 'a', status: 'sent', failed_at: null },
      { contact_id: 'b', status: 'failed', failed_at: OLD },
      { contact_id: 'c', status: 'capped', failed_at: OLD },   // expired park → retryable
      { contact_id: 'd', status: 'capped', failed_at: FRESH }, // still parked → done
    ])
    const done = await fetchDripDoneContactIds(db, 'bc1')
    expect(done.sort()).toEqual(['a', 'b', 'd'])
  })
})

function consentDb({ contact, writes }) {
  return {
    from: (table) => ({
      select: () => ({ or: () => ({ limit: () => Promise.resolve({ data: contact ? [contact] : [] }) }) }),
      update: (patch) => { writes.push([table, patch]); return { eq: () => Promise.resolve({ error: null }) } },
      insert: (row) => { writes.push([table, row]); return Promise.resolve({ error: null }) },
    }),
  }
}

describe('applyMetaUserPreference', () => {
  it('stop → marketing off + wa_status opted_out + consent_log audit', async () => {
    const writes = []
    const db = consentDb({ contact: { id: 'c1' }, writes })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', category: 'marketing_messages', value: 'stop' })
    expect(r).toMatchObject({ applied: true, action: 'opted_out' })
    expect(writes).toEqual([
      ['contact_preferences', { whatsapp_marketing: false }],
      ['contacts', { wa_status: 'opted_out' }],
      ['consent_log', expect.objectContaining({ action: 'opted_out', source: 'meta_user_preferences' })],
    ])
  })
  it('resume → re-opted in', async () => {
    const writes = []
    const db = consentDb({ contact: { id: 'c1' }, writes })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', value: 'resume' })
    expect(r.action).toBe('opted_in')
    expect(writes[0]).toEqual(['contact_preferences', { whatsapp_marketing: true }])
  })
  it('unknown contact / bad value → not applied, no writes', async () => {
    const writes = []
    expect((await applyMetaUserPreference(consentDb({ contact: null, writes }), { wa_id: '1', value: 'stop' })).applied).toBe(false)
    expect((await applyMetaUserPreference(consentDb({ contact: { id: 'c1' }, writes }), { wa_id: '1', value: 'nonsense' })).applied).toBe(false)
    expect(writes).toEqual([])
  })
})
