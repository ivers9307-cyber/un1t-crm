import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createOpenWearablesClient,
  getOpenWearablesConfig,
  OpenWearablesError,
} from './openwearables.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV = {
  OPENWEARABLES_BASE_URL: 'http://ow.test:8000',
  OPENWEARABLES_API_KEY: 'dev-key-123',
  OPENWEARABLES_APP_ID: 'app-id-abc',
  OPENWEARABLES_APP_SECRET: 'app-secret-xyz',
}

// Builds a fake fetch Response with the given JSON body + status.
function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

// Returns { url, options } of the Nth fetch call (default last).
function fetchCall(n = -1) {
  const calls = global.fetch.mock.calls
  const call = n < 0 ? calls[calls.length + n] : calls[n]
  return { url: call[0], options: call[1] }
}

describe('openwearables client', () => {
  const original = {}

  beforeEach(() => {
    for (const key of Object.keys(ENV)) {
      original[key] = process.env[key]
      process.env[key] = ENV[key]
    }
    global.fetch = vi.fn()
  })

  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Config / env
  // -------------------------------------------------------------------------

  describe('getOpenWearablesConfig', () => {
    it('reads all four vars and strips a trailing slash from the base URL', () => {
      process.env.OPENWEARABLES_BASE_URL = 'http://ow.test:8000/'
      const cfg = getOpenWearablesConfig()
      expect(cfg).toEqual({
        baseUrl: 'http://ow.test:8000',
        apiKey: 'dev-key-123',
        appId: 'app-id-abc',
        appSecret: 'app-secret-xyz',
      })
    })

    it.each(Object.keys(ENV))('throws when %s is unset (no silent fallback)', (missing) => {
      delete process.env[missing]
      expect(() => getOpenWearablesConfig()).toThrow(/not configured/)
      expect(() => getOpenWearablesConfig()).toThrow(new RegExp(missing))
    })

    it('createOpenWearablesClient throws immediately on missing env', () => {
      delete process.env.OPENWEARABLES_API_KEY
      expect(() => createOpenWearablesClient()).toThrow(/not configured/)
    })
  })

  // -------------------------------------------------------------------------
  // Auth header (applies to every call)
  // -------------------------------------------------------------------------

  describe('auth headers', () => {
    it('sends the API key in both X-Open-Wearables-API-Key and Bearer', async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'u1' }] }))
      const client = createOpenWearablesClient()
      await client.ensureUser({ externalUserId: 'ext-1' })

      const { options } = fetchCall()
      expect(options.headers['X-Open-Wearables-API-Key']).toBe('dev-key-123')
      expect(options.headers.Authorization).toBe('Bearer dev-key-123')
      expect(options.headers.Accept).toBe('application/json')
    })
  })

  // -------------------------------------------------------------------------
  // ensureUser
  // -------------------------------------------------------------------------

  describe('ensureUser', () => {
    it('returns the existing user without POSTing when lookup finds one', async () => {
      const existing = { id: 'ow-1', external_user_id: 'ext-1' }
      global.fetch.mockResolvedValueOnce(jsonResponse({ data: [existing] }))

      const client = createOpenWearablesClient()
      const result = await client.ensureUser({ externalUserId: 'ext-1' })

      expect(result).toEqual(existing)
      expect(global.fetch).toHaveBeenCalledTimes(1)

      const { url, options } = fetchCall()
      expect(options.method ?? 'GET').toBe('GET')
      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe('http://ow.test:8000/api/v1/users')
      expect(parsed.searchParams.get('external_user_id')).toBe('ext-1')
    })

    it('creates the user when the lookup is empty, sending mapped fields', async () => {
      global.fetch
        .mockResolvedValueOnce(jsonResponse({ data: [] }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 'ow-new', external_user_id: 'ext-2' }, { status: 201 })
        )

      const client = createOpenWearablesClient()
      const result = await client.ensureUser({
        externalUserId: 'ext-2',
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      })

      expect(result).toEqual({ id: 'ow-new', external_user_id: 'ext-2' })
      expect(global.fetch).toHaveBeenCalledTimes(2)

      const { url, options } = fetchCall() // the POST
      expect(options.method).toBe('POST')
      expect(new URL(url).pathname).toBe('/api/v1/users')
      expect(options.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(options.body)).toEqual({
        external_user_id: 'ext-2',
        email: 'a@b.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
      })
    })

    it('throws when externalUserId is missing', async () => {
      const client = createOpenWearablesClient()
      await expect(client.ensureUser({})).rejects.toThrow(/externalUserId/)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // mintUserToken
  // -------------------------------------------------------------------------

  describe('mintUserToken', () => {
    it('POSTs to the user token endpoint with app credentials from env', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse({ access_token: 'jwt-abc', token_type: 'bearer' })
      )

      const client = createOpenWearablesClient()
      const result = await client.mintUserToken('ow-1')

      expect(result).toEqual({ access_token: 'jwt-abc', token_type: 'bearer' })

      const { url, options } = fetchCall()
      expect(options.method).toBe('POST')
      expect(new URL(url).pathname).toBe('/api/v1/users/ow-1/token')
      expect(JSON.parse(options.body)).toEqual({
        app_id: 'app-id-abc',
        app_secret: 'app-secret-xyz',
      })
    })

    it('URL-encodes the user id in the path', async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({ access_token: 't' }))
      const client = createOpenWearablesClient()
      await client.mintUserToken('a/b c')
      expect(fetchCall().url).toContain('/api/v1/users/a%2Fb%20c/token')
    })

    it('throws when owUserId is missing', async () => {
      const client = createOpenWearablesClient()
      await expect(client.mintUserToken()).rejects.toThrow(/owUserId/)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getWorkout
  // -------------------------------------------------------------------------

  describe('getWorkout', () => {
    it('GETs the provider/user/workout path and parses the body', async () => {
      const workout = {
        type: 'running',
        start_time: '2026-06-20T07:00:00Z',
        avg_heart_rate_bpm: 142,
      }
      global.fetch.mockResolvedValueOnce(jsonResponse(workout))

      const client = createOpenWearablesClient()
      const result = await client.getWorkout({
        provider: 'apple',
        userId: 'ow-1',
        workoutId: 'wk-9',
      })

      expect(result).toEqual(workout)
      const { url, options } = fetchCall()
      expect(options.method ?? 'GET').toBe('GET')
      expect(new URL(url).pathname).toBe(
        '/api/v1/providers/apple/users/ow-1/workouts/wk-9'
      )
    })

    it('throws when any of provider/userId/workoutId is missing', async () => {
      const client = createOpenWearablesClient()
      await expect(
        client.getWorkout({ provider: 'apple', userId: 'ow-1' })
      ).rejects.toThrow(/provider, userId, and workoutId/)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getHeartRateTimeseries
  // -------------------------------------------------------------------------

  describe('getHeartRateTimeseries', () => {
    it('builds the right URL with start_time/end_time/types=heart_rate', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse({
          data: [{ timestamp: '2026-06-20T07:00:00Z', type: 'heart_rate', value: 120, unit: 'count/min' }],
          pagination: { has_more: false, next_cursor: null },
          metadata: {},
        })
      )

      const client = createOpenWearablesClient()
      const samples = await client.getHeartRateTimeseries({
        userId: 'ow-1',
        startIso: '2026-06-20T00:00:00Z',
        endIso: '2026-06-20T23:59:59Z',
      })

      expect(samples).toHaveLength(1)
      expect(samples[0].value).toBe(120)

      const { url } = fetchCall()
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/api/v1/users/ow-1/timeseries')
      expect(parsed.searchParams.get('start_time')).toBe('2026-06-20T00:00:00Z')
      expect(parsed.searchParams.get('end_time')).toBe('2026-06-20T23:59:59Z')
      expect(parsed.searchParams.getAll('types')).toEqual(['heart_rate'])
      expect(parsed.searchParams.has('cursor')).toBe(false)
    })

    it('follows cursor pagination and flattens all pages', async () => {
      global.fetch
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ timestamp: 't1', type: 'heart_rate', value: 100, unit: 'count/min' }],
            pagination: { has_more: true, next_cursor: 'CURSOR_2' },
            metadata: {},
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ timestamp: 't2', type: 'heart_rate', value: 101, unit: 'count/min' }],
            pagination: { has_more: true, next_cursor: 'CURSOR_3' },
            metadata: {},
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ timestamp: 't3', type: 'heart_rate', value: 102, unit: 'count/min' }],
            pagination: { has_more: false, next_cursor: null },
            metadata: {},
          })
        )

      const client = createOpenWearablesClient()
      const samples = await client.getHeartRateTimeseries({
        userId: 'ow-1',
        startIso: '2026-06-20T00:00:00Z',
        endIso: '2026-06-20T23:59:59Z',
      })

      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(samples.map((s) => s.value)).toEqual([100, 101, 102])

      // First page sends no cursor; subsequent pages forward the prior cursor.
      expect(new URL(fetchCall(0).url).searchParams.has('cursor')).toBe(false)
      expect(new URL(fetchCall(1).url).searchParams.get('cursor')).toBe('CURSOR_2')
      expect(new URL(fetchCall(2).url).searchParams.get('cursor')).toBe('CURSOR_3')
    })

    it('stops paginating when has_more is true but next_cursor is null', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse({
          data: [{ timestamp: 't1', type: 'heart_rate', value: 100, unit: 'count/min' }],
          pagination: { has_more: true, next_cursor: null },
          metadata: {},
        })
      )

      const client = createOpenWearablesClient()
      const samples = await client.getHeartRateTimeseries({
        userId: 'ow-1',
        startIso: 's',
        endIso: 'e',
      })

      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(samples).toHaveLength(1)
    })

    it('throws when required args are missing', async () => {
      const client = createOpenWearablesClient()
      await expect(
        client.getHeartRateTimeseries({ userId: 'ow-1', startIso: 's' })
      ).rejects.toThrow(/userId, startIso, and endIso/)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // ensureWebhookEndpoint
  // -------------------------------------------------------------------------

  describe('ensureWebhookEndpoint', () => {
    it('POSTs the url with filter_types when eventTypes are provided', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse({ id: 'ep-1', url: 'https://crm/api/webhooks/ow' }, { status: 201 })
      )

      const client = createOpenWearablesClient()
      const result = await client.ensureWebhookEndpoint({
        url: 'https://crm/api/webhooks/ow',
        eventTypes: ['sync.completed', 'connection.created'],
      })

      expect(result).toEqual({ id: 'ep-1', url: 'https://crm/api/webhooks/ow' })

      const { url, options } = fetchCall()
      expect(options.method).toBe('POST')
      expect(new URL(url).pathname).toBe('/api/v1/webhooks/endpoints')
      expect(JSON.parse(options.body)).toEqual({
        url: 'https://crm/api/webhooks/ow',
        filter_types: ['sync.completed', 'connection.created'],
      })
    })

    it('omits filter_types when no eventTypes are given', async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({ id: 'ep-2' }, { status: 201 }))

      const client = createOpenWearablesClient()
      await client.ensureWebhookEndpoint({ url: 'https://crm/hook' })

      const body = JSON.parse(fetchCall().options.body)
      expect(body).toEqual({ url: 'https://crm/hook' })
      expect('filter_types' in body).toBe(false)
    })

    it('throws when url is missing', async () => {
      const client = createOpenWearablesClient()
      await expect(client.ensureWebhookEndpoint({})).rejects.toThrow(/url/)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getTimeseries
  // -------------------------------------------------------------------------

  describe('getTimeseries', () => {
    it('pages and returns typed samples', async () => {
      const pages = [
        { data: [{ type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 52, unit: 'count/min' }], pagination: { has_more: true, next_cursor: 'c1' } },
        { data: [{ type: 'vo2_max', timestamp: '2026-06-21T00:00:00Z', value: 48.2, unit: 'mL/min·kg' }], pagination: { has_more: false } },
      ]
      global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pages.shift()) }))
      const client = createOpenWearablesClient()
      const out = await client.getTimeseries({ userId: 'u1', types: ['resting_heart_rate', 'vo2_max'], startIso: '2026-06-01T00:00:00Z', endIso: '2026-06-30T00:00:00Z' })
      expect(out).toHaveLength(2)
      expect(out[0].type).toBe('resting_heart_rate')
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('validates args — throws when types is empty array', async () => {
      const client = createOpenWearablesClient()
      await expect(client.getTimeseries({ userId: 'u1', types: [], startIso: 'a', endIso: 'b' })).rejects.toThrow()
    })

    it('validates args — throws when userId is missing', async () => {
      const client = createOpenWearablesClient()
      await expect(client.getTimeseries({ types: ['resting_heart_rate'], startIso: 'a', endIso: 'b' })).rejects.toThrow()
    })

    it('sends types as repeated query params', async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({ data: [], pagination: { has_more: false } }))
      const client = createOpenWearablesClient()
      await client.getTimeseries({ userId: 'u1', types: ['resting_heart_rate', 'vo2_max'], startIso: '2026-06-01T00:00:00Z', endIso: '2026-06-30T00:00:00Z' })
      const { url } = fetchCall()
      const parsed = new URL(url)
      expect(parsed.searchParams.getAll('types')).toEqual(['resting_heart_rate', 'vo2_max'])
      expect(parsed.searchParams.get('start_time')).toBe('2026-06-01T00:00:00Z')
      expect(parsed.searchParams.get('end_time')).toBe('2026-06-30T00:00:00Z')
    })
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('non-2xx handling', () => {
    it('throws OpenWearablesError carrying status + body on a 401', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse({ detail: 'Authentication required: provide JWT token or API key' }, { status: 401 })
      )

      const client = createOpenWearablesClient()
      const err = await client.mintUserToken('ow-1').catch((e) => e)

      expect(err).toBeInstanceOf(OpenWearablesError)
      expect(err.status).toBe(401)
      expect(err.message).toMatch(/401/)
      expect(err.message).toMatch(/Authentication required/)
      expect(err.body).toEqual({
        detail: 'Authentication required: provide JWT token or API key',
      })
    })

    it('surfaces a 422 validation body', async () => {
      global.fetch.mockResolvedValueOnce(
        jsonResponse(
          { detail: [{ loc: ['body', 'url'], msg: 'field required', type: 'value_error.missing' }] },
          { status: 422 }
        )
      )

      const client = createOpenWearablesClient()
      const err = await client
        .ensureWebhookEndpoint({ url: 'https://crm/hook' })
        .catch((e) => e)

      expect(err).toBeInstanceOf(OpenWearablesError)
      expect(err.status).toBe(422)
      expect(err.message).toMatch(/422/)
    })

    it('falls back to the status when the error body is non-JSON / empty', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '',
      })

      const client = createOpenWearablesClient()
      const err = await client.getWorkout({
        provider: 'apple',
        userId: 'u',
        workoutId: 'w',
      }).catch((e) => e)

      expect(err).toBeInstanceOf(OpenWearablesError)
      expect(err.status).toBe(500)
      expect(err.message).toMatch(/HTTP 500/)
      expect(err.body).toBeNull()
    })
  })
})
