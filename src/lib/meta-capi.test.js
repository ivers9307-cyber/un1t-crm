import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildBusinessMessagingEvent, captureCtwaReferral, sendCtwaConversion, recordCtwaTouch } from './meta-capi.js'

describe('buildBusinessMessagingEvent', () => {
  it('builds the business_messaging event shape', () => {
    const ev = buildBusinessMessagingEvent({ eventName: 'Lead', ctwaClid: 'clid1', wabaId: 'waba1', eventTime: 1234, contentName: 'HIIT' })
    expect(ev).toEqual({
      event_name: 'Lead',
      event_time: 1234,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: 'clid1', whatsapp_business_account_id: 'waba1' },
      custom_data: { content_name: 'HIIT' },
    })
  })
  it('omits waba and custom_data when absent', () => {
    const ev = buildBusinessMessagingEvent({ eventName: 'Schedule', ctwaClid: 'c', eventTime: 1 })
    expect(ev.user_data).toEqual({ ctwa_clid: 'c' })
    expect(ev.custom_data).toBeUndefined()
  })
})

// Chainable fake supabase client: from(table) → builder recording updates,
// resolving selects from `state`.
function fakeDb(state) {
  const updates = []
  function builder(table) {
    const b = {
      _table: table, _patch: null, _isNullCol: null,
      update(patch) { b._patch = patch; return b },
      select() { return b },
      eq() { return b },
      is(col) { b._isNullCol = col; return b },
      limit() { return b },
      maybeSingle() { return Promise.resolve({ data: state[table] ?? null }) },
      then(resolve) {
        // awaited terminal: an update chain resolves with rows-updated when the
        // stamped column was null, [] otherwise; bare selects resolve from state
        if (b._patch) {
          updates.push([table, b._patch])
          const row = state[table]
          const wasNull = row ? row[b._isNullCol] == null : false
          return resolve({ data: b._isNullCol == null || wasNull ? [{ id: 'x' }] : [] })
        }
        return resolve({ data: state[table] ?? null })
      },
    }
    return b
  }
  return { db: { from: builder }, updates }
}

describe('captureCtwaReferral', () => {
  it('returns true when the contact had no clid (row updated)', async () => {
    const { db } = fakeDb({ contacts: { ctwa_clid: null } })
    expect(await captureCtwaReferral(db, 'c1', 'clid')).toBe(true)
  })
  it('returns false when already stamped', async () => {
    const { db } = fakeDb({ contacts: { ctwa_clid: 'existing' } })
    expect(await captureCtwaReferral(db, 'c1', 'clid')).toBe(false)
  })
})

describe('sendCtwaConversion', () => {
  const CONTACT = { ctwa_clid: 'clid9' }
  const LOC = { settings: { meta_ads: { dataset_id: 'ds1' } } }
  const NUM = { access_token: 'tok', business_account_id: 'waba9' }

  beforeEach(() => { global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) })
  afterEach(() => { vi.restoreAllMocks() })

  it('no stored clid → no fetch', async () => {
    const { db } = fakeDb({ contacts: { ctwa_clid: null }, locations: LOC, whatsapp_numbers: NUM })
    const r = await sendCtwaConversion(db, { locationId: 'l1', contactId: 'c1', eventName: 'Schedule' })
    expect(r).toEqual({ sent: false, reason: 'no_ctwa_clid' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('no dataset configured → no fetch (gated off)', async () => {
    const { db } = fakeDb({ contacts: CONTACT, locations: { settings: {} }, whatsapp_numbers: NUM })
    const r = await sendCtwaConversion(db, { locationId: 'l1', contactId: 'c1', eventName: 'Schedule' })
    expect(r).toEqual({ sent: false, reason: 'no_dataset' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('happy path posts the event to the dataset with the number token', async () => {
    const { db } = fakeDb({ contacts: CONTACT, locations: LOC, whatsapp_numbers: NUM })
    const r = await sendCtwaConversion(db, { locationId: 'l1', contactId: 'c1', eventName: 'Schedule', contentName: 'ENT1TY' })
    expect(r).toEqual({ sent: true })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/ds1/events')
    const body = JSON.parse(opts.body)
    expect(body.access_token).toBe('tok')
    expect(body.data[0]).toMatchObject({
      event_name: 'Schedule', action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: 'clid9', whatsapp_business_account_id: 'waba9' },
      custom_data: { content_name: 'ENT1TY' },
    })
  })
  it('API error → sent:false, never throws', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) }))
    const { db } = fakeDb({ contacts: CONTACT, locations: LOC, whatsapp_numbers: NUM })
    const r = await sendCtwaConversion(db, { locationId: 'l1', contactId: 'c1', eventName: 'Lead' })
    expect(r).toEqual({ sent: false, reason: 'api_error' })
  })
})

describe('recordCtwaTouch', () => {
  beforeEach(() => { global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) })
  afterEach(() => { vi.restoreAllMocks() })

  it('stamps conversation + contact and fires Lead once when newly set', async () => {
    const { db, updates } = fakeDb({
      contacts: { ctwa_clid: null },
      whatsapp_conversations: { ctwa_clid: null },
      locations: { settings: { meta_ads: { dataset_id: 'ds1' } } },
      whatsapp_numbers: { access_token: 'tok', business_account_id: 'w' },
    })
    await recordCtwaTouch(db, { ctwaClid: 'clid1', conversationId: 'conv1', contact: { id: 'c1' }, locationId: 'l1' })
    expect(updates.map(([t]) => t)).toEqual(['whatsapp_conversations', 'contacts'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0][1].body).data[0].event_name).toBe('Lead')
  })
  it('already-stamped contact fires nothing (webhook retry no-op)', async () => {
    const { db } = fakeDb({ contacts: { ctwa_clid: 'clid1' }, whatsapp_conversations: { ctwa_clid: 'clid1' } })
    await recordCtwaTouch(db, { ctwaClid: 'clid1', conversationId: 'conv1', contact: { id: 'c1' }, locationId: 'l1' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('no clid → no-op; unknown sender (no contact) still stamps the conversation', async () => {
    const { db, updates } = fakeDb({ whatsapp_conversations: { ctwa_clid: null } })
    await recordCtwaTouch(db, { ctwaClid: null, conversationId: 'conv1', contact: null, locationId: 'l1' })
    expect(updates).toEqual([])
    await recordCtwaTouch(db, { ctwaClid: 'clid2', conversationId: 'conv1', contact: null, locationId: 'l1' })
    expect(updates).toEqual([['whatsapp_conversations', expect.objectContaining({ ctwa_clid: 'clid2' })]])
    expect(fetch).not.toHaveBeenCalled()
  })
})
