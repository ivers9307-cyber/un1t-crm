import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeEmailForMeta, normalizePhoneForMeta, sha256Hex, buildWebsiteEvent, sendWebsiteConversion } from './meta-capi.js'

describe('normalizeEmailForMeta', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmailForMeta('  Vicky.S@Example.COM ')).toBe('vicky.s@example.com')
  })
  it('rejects non-emails', () => {
    expect(normalizeEmailForMeta('not-an-email')).toBeNull()
    expect(normalizeEmailForMeta('')).toBeNull()
    expect(normalizeEmailForMeta(null)).toBeNull()
  })
})

describe('normalizePhoneForMeta', () => {
  it('converts Irish national format to country-code digits', () => {
    expect(normalizePhoneForMeta('087 123 4567')).toBe('353871234567')
  })
  it('strips + and formatting from international numbers', () => {
    expect(normalizePhoneForMeta('+353 87 123 4567')).toBe('353871234567')
    expect(normalizePhoneForMeta('+44 7700 900123')).toBe('447700900123')
  })
  it('strips 00 international prefixes', () => {
    expect(normalizePhoneForMeta('00353871234567')).toBe('353871234567')
  })
  it('rejects junk and too-short values', () => {
    expect(normalizePhoneForMeta('123')).toBeNull()
    expect(normalizePhoneForMeta('')).toBeNull()
    expect(normalizePhoneForMeta(null)).toBeNull()
  })
})

describe('buildWebsiteEvent', () => {
  it('builds the website event with hashed identifiers', () => {
    const ev = buildWebsiteEvent({
      eventName: 'Lead', eventTime: 1234,
      email: 'Test@Example.com', phone: '087 123 4567',
      eventSourceUrl: 'https://www.un1tdublin.com/start',
      eventId: 'weblead-abc', contentName: 'FUS1ON',
    })
    expect(ev).toEqual({
      event_name: 'Lead',
      event_time: 1234,
      action_source: 'website',
      event_source_url: 'https://www.un1tdublin.com/start',
      event_id: 'weblead-abc',
      user_data: {
        em: [sha256Hex('test@example.com')],
        ph: [sha256Hex('353871234567')],
      },
      custom_data: { content_name: 'FUS1ON' },
    })
  })
  it('hashes match the SHA-256 spec', () => {
    // Known vector: sha256('test') — proves we hash the normalized value, unsalted.
    expect(sha256Hex('test')).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
  })
  it('omits the identifier that fails to normalize', () => {
    const ev = buildWebsiteEvent({ eventName: 'Lead', eventTime: 1, email: 'a@b.ie', phone: 'junk' })
    expect(ev.user_data.em).toHaveLength(1)
    expect(ev.user_data.ph).toBeUndefined()
  })
  it('returns null when nothing normalizes — unmatchable events are not worth sending', () => {
    expect(buildWebsiteEvent({ eventName: 'Lead', eventTime: 1, email: 'junk', phone: '1' })).toBeNull()
  })
  it('omits optional fields when absent', () => {
    const ev = buildWebsiteEvent({ eventName: 'Schedule', eventTime: 1, email: 'a@b.ie' })
    expect(ev.event_source_url).toBeUndefined()
    expect(ev.event_id).toBeUndefined()
    expect(ev.custom_data).toBeUndefined()
  })
})

// Minimal chainable fake supabase client resolving selects from `state`.
function fakeDb(state) {
  function builder(table) {
    const b = {
      select() { return b },
      eq() { return b },
      is() { return b },
      limit() { return b },
      maybeSingle() { return Promise.resolve({ data: state[table] ?? null }) },
    }
    return b
  }
  return { from: builder }
}

describe('sendWebsiteConversion', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  const args = {
    locationId: 'loc1', eventName: 'Schedule',
    email: 'a@b.ie', phone: '0871234567',
    eventSourceUrl: 'https://www.un1tdublin.com/start', eventId: 'booking-1',
  }

  it('no-ops without a locationId', async () => {
    const r = await sendWebsiteConversion(fakeDb({}), { ...args, locationId: null })
    expect(r).toEqual({ sent: false, reason: 'no_location' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('no-ops when no identifier normalizes', async () => {
    const r = await sendWebsiteConversion(fakeDb({}), { ...args, email: 'junk', phone: '1' })
    expect(r).toEqual({ sent: false, reason: 'no_identifiers' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('no-ops when the location has no dataset_id', async () => {
    const db = fakeDb({ locations: { settings: { meta_ads: {} } } })
    const r = await sendWebsiteConversion(db, args)
    expect(r).toEqual({ sent: false, reason: 'no_dataset' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('no-ops when the location has no active number token', async () => {
    const db = fakeDb({
      locations: { settings: { meta_ads: { dataset_id: 'ds1' } } },
      whatsapp_numbers: null,
    })
    const r = await sendWebsiteConversion(db, args)
    expect(r).toEqual({ sent: false, reason: 'no_token' })
  })

  it('posts the event to the dataset with the number token', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    const db = fakeDb({
      locations: { settings: { meta_ads: { dataset_id: 'ds1' } } },
      whatsapp_numbers: { access_token: 'tok1', business_account_id: 'waba1' },
    })
    const r = await sendWebsiteConversion(db, args)
    expect(r).toEqual({ sent: true })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/ds1/events')
    const body = JSON.parse(opts.body)
    expect(body.access_token).toBe('tok1')
    expect(body.data).toHaveLength(1)
    expect(body.data[0].event_name).toBe('Schedule')
    expect(body.data[0].action_source).toBe('website')
    expect(body.data[0].event_id).toBe('booking-1')
    expect(body.data[0].user_data.em[0]).toBe(sha256Hex('a@b.ie'))
    expect(body.data[0].user_data.ph[0]).toBe(sha256Hex('353871234567'))
  })

  it('reports api_error on a Graph error without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: { message: 'bad' } }) })
    const db = fakeDb({
      locations: { settings: { meta_ads: { dataset_id: 'ds1' } } },
      whatsapp_numbers: { access_token: 'tok1' },
    })
    const r = await sendWebsiteConversion(db, args)
    expect(r).toEqual({ sent: false, reason: 'api_error' })
  })

  it('swallows exceptions — attribution must never break a booking', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch.mockRejectedValue(new Error('network down'))
    const db = fakeDb({
      locations: { settings: { meta_ads: { dataset_id: 'ds1' } } },
      whatsapp_numbers: { access_token: 'tok1' },
    })
    const r = await sendWebsiteConversion(db, args)
    expect(r).toEqual({ sent: false, reason: 'exception' })
  })
})
