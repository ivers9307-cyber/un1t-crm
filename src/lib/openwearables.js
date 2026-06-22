// Open Wearables (OW) REST client — thin HTTP wrapper over our self-hosted
// Open Wearables server. Used by the Apple Watch ingestion feature
// (WEARABLE-INGEST): the mapper, the connect endpoint, and the webhook
// receiver all build on the methods here. Pure HTTP + small helpers — no
// Supabase, no Next.js runtime assumptions (it's a lib, callable from any
// runtime that has a global `fetch`).
//
// All request/response shapes, query-param names, and the auth header were
// confirmed against the live server's `/openapi.json` (API title
// "Open Wearables API 0.1.0"), NOT from cached knowledge. Notable details
// that the spec pinned down:
//
//   * Auth. The server accepts two distinct credentials: a JWT/SDK token
//     (via the `OAuth2PasswordBearer` security scheme → `Authorization:
//     Bearer <token>`) OR a developer API key (via a dedicated
//     `X-Open-Wearables-API-Key` header that every authenticated route
//     declares). The live 401 body confirms it: "Authentication required:
//     provide JWT token or API key". We therefore send the developer API
//     key in BOTH the `X-Open-Wearables-API-Key` header (the spec-correct
//     slot for an API key) and as `Authorization: Bearer` (the only
//     declared security scheme) — belt-and-braces, costs nothing.
//
//   * Per-user SDK token. `POST /api/v1/users/{id}/token` mints a token for
//     a user, but the body must carry an *application's* `app_id` /
//     `app_secret` (created via `POST /api/v1/applications` →
//     ApplicationReadWithSecret). The response is a `TokenResponse`
//     ({ access_token, token_type, refresh_token?, expires_in? }).
//
//   * HR timeseries. `GET /api/v1/users/{user_id}/timeseries` uses
//     `start_time` / `end_time` (NOT startIso/endIso), a repeatable
//     `types` array param (we pass `heart_rate`), and CURSOR pagination —
//     the wrapper is `PaginatedResponse[TimeSeriesSample]` with
//     `{ data, pagination: { next_cursor, has_more }, metadata }`, paged
//     via the `cursor` query param.
//
//   * User lookup. `GET /api/v1/users` filters by `external_user_id` (query
//     param) and returns an `OldPaginatedResponse[UserRead]` ({ data, ... }).
//     `ensureUser` is create-or-return-existing keyed on that.
//
//   * Webhook event-types (`GET /api/v1/webhooks/event-types`) is the one
//     unauthenticated route; everything else requires the credential above.

const REQUIRED_ENV = [
  'OPENWEARABLES_BASE_URL',
  'OPENWEARABLES_API_KEY',
  'OPENWEARABLES_APP_ID',
  'OPENWEARABLES_APP_SECRET',
]

/**
 * Error thrown for any non-2xx response from the OW server. Carries the
 * HTTP status and the raw (best-effort parsed) body so callers can branch
 * on `err.status` and inspect `err.body`.
 */
export class OpenWearablesError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'OpenWearablesError'
    this.status = status
    this.body = body
  }
}

/**
 * Reads + validates client config from the environment. Follows the repo's
 * no-silent-env-fallback rule (mirrors getAppUrl() in app-url.js) — throws a
 * descriptive error if any required var is unset so a misconfiguration
 * surfaces immediately rather than failing opaquely against the API.
 *
 * @returns {{ baseUrl: string, apiKey: string, appId: string, appSecret: string }}
 */
export function getOpenWearablesConfig() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Open Wearables client is not configured. Missing required ` +
        `environment variable(s): ${missing.join(', ')}. Set OPENWEARABLES_BASE_URL ` +
        `(e.g. http://localhost:8000 in dev), OPENWEARABLES_API_KEY (a developer API ` +
        `key), and OPENWEARABLES_APP_ID / OPENWEARABLES_APP_SECRET (from an OW ` +
        `application created via POST /api/v1/applications).`
    )
  }
  return {
    baseUrl: process.env.OPENWEARABLES_BASE_URL.replace(/\/+$/, ''),
    apiKey: process.env.OPENWEARABLES_API_KEY,
    appId: process.env.OPENWEARABLES_APP_ID,
    appSecret: process.env.OPENWEARABLES_APP_SECRET,
  }
}

/**
 * Creates an Open Wearables REST client bound to the current environment
 * config. Each method is async, returns parsed JSON, and throws an
 * OpenWearablesError on any non-2xx response.
 *
 * @returns {{
 *   ensureUser: (args: { externalUserId: string, email?: string, firstName?: string, lastName?: string }) => Promise<object>,
 *   mintUserToken: (owUserId: string) => Promise<object>,
 *   getWorkout: (args: { provider: string, userId: string, workoutId: string }) => Promise<object>,
 *   getHeartRateTimeseries: (args: { userId: string, startIso: string, endIso: string }) => Promise<object[]>,
 *   ensureWebhookEndpoint: (args: { url: string, eventTypes?: string[] }) => Promise<object>,
 * }}
 */
export function createOpenWearablesClient() {
  const config = getOpenWearablesConfig()

  // The single choke-point for base URL + auth headers + error handling.
  // `path` is the API path (leading slash); `query` is an optional object of
  // query params (array values are appended as repeated keys, matching the
  // FastAPI array-param convention the spec uses for `types`).
  async function request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${config.baseUrl}${path}`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, item)
        } else {
          url.searchParams.append(key, value)
        }
      }
    }

    const headers = {
      Accept: 'application/json',
      // Developer API key — sent in both slots the server recognises (see
      // module header). The dedicated API-key header is the spec-correct
      // home for an API key; the Bearer mirror covers the declared
      // OAuth2PasswordBearer scheme.
      'X-Open-Wearables-API-Key': config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    // The server returns JSON on success and on error (FastAPI's
    // { detail: ... } shape). Parse best-effort so we can surface the body
    // even when the status is non-2xx or the body is empty.
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        // Non-JSON body — keep `json` null and fall through to the status.
      }
    }

    if (!res.ok) {
      const detail =
        (json && (json.detail || json.message || json.error)) ||
        (typeof json === 'string' ? json : null) ||
        text ||
        `HTTP ${res.status}`
      const detailStr =
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      throw new OpenWearablesError(
        `Open Wearables API ${method} ${path} failed (${res.status}): ${detailStr}`,
        { status: res.status, body: json ?? (text || null) }
      )
    }

    return json
  }

  return {
    /**
     * Create-or-return-existing OW user for one of our external ids. Looks
     * the user up first via `GET /api/v1/users?external_user_id=…`; if a row
     * exists it's returned unchanged, otherwise a new user is created via
     * `POST /api/v1/users`. Returns a UserRead ({ id, external_user_id, … }).
     */
    async ensureUser({ externalUserId, email, firstName, lastName } = {}) {
      if (!externalUserId) {
        throw new Error('ensureUser requires an externalUserId')
      }
      const existing = await request('/api/v1/users', {
        query: { external_user_id: externalUserId, limit: 1 },
      })
      const found = Array.isArray(existing?.data) ? existing.data : []
      if (found.length > 0) return found[0]

      return request('/api/v1/users', {
        method: 'POST',
        body: {
          external_user_id: externalUserId,
          email,
          first_name: firstName,
          last_name: lastName,
        },
      })
    },

    /**
     * Mints a per-user SDK token. The OW endpoint requires the application
     * credentials (app_id / app_secret) in the body — supplied from env, not
     * by the caller. Returns a TokenResponse ({ access_token, token_type,
     * refresh_token?, expires_in? }).
     */
    async mintUserToken(owUserId) {
      if (!owUserId) throw new Error('mintUserToken requires an owUserId')
      return request(`/api/v1/users/${encodeURIComponent(owUserId)}/token`, {
        method: 'POST',
        body: { app_id: config.appId, app_secret: config.appSecret },
      })
    },

    /**
     * Fetches a single workout's detail for a provider+user. Returns the
     * Workout-Output object ({ type, start_time, end_time, duration_seconds,
     * calories_kcal, distance_meters, avg_heart_rate_bpm, max_heart_rate_bpm,
     * source, … }).
     */
    async getWorkout({ provider, userId, workoutId } = {}) {
      if (!provider || !userId || !workoutId) {
        throw new Error('getWorkout requires provider, userId, and workoutId')
      }
      return request(
        `/api/v1/providers/${encodeURIComponent(provider)}/users/` +
          `${encodeURIComponent(userId)}/workouts/${encodeURIComponent(workoutId)}`
      )
    },

    /**
     * Fetches heart-rate timeseries samples for a user over [startIso,
     * endIso]. Transparently follows cursor pagination
     * (PaginatedResponse[TimeSeriesSample].pagination.next_cursor /
     * .has_more) and returns the flat array of all TimeSeriesSample rows
     * ({ timestamp, type, value, unit, … }).
     *
     * A HARD_PAGE_LIMIT bounds the loop so a server that always reports
     * has_more can't spin forever.
     */
    async getHeartRateTimeseries({ userId, startIso, endIso } = {}) {
      if (!userId || !startIso || !endIso) {
        throw new Error(
          'getHeartRateTimeseries requires userId, startIso, and endIso'
        )
      }
      const HARD_PAGE_LIMIT = 1000
      const samples = []
      let cursor
      let more = true
      let pages = 0
      while (more && pages < HARD_PAGE_LIMIT) {
        const res = await request(
          `/api/v1/users/${encodeURIComponent(userId)}/timeseries`,
          {
            query: {
              start_time: startIso,
              end_time: endIso,
              types: ['heart_rate'],
              cursor,
            },
          }
        )
        const page = Array.isArray(res?.data) ? res.data : []
        samples.push(...page)
        pages += 1
        const pagination = res?.pagination || {}
        cursor = pagination.next_cursor
        more = Boolean(pagination.has_more && cursor)
      }
      return samples
    },

    /**
     * Fetches arbitrary timeseries samples for a user over [startIso,
     * endIso] for a given set of metric types. Transparently follows cursor
     * pagination and returns the flat array of all TimeSeriesSample rows.
     * Unlike getHeartRateTimeseries (which always requests type=heart_rate),
     * this method passes the caller-supplied types array as repeated `types`
     * query params so the caller can pull resting_heart_rate, hrv, vo2_max
     * (etc.) in one paginated sweep.
     */
    async getTimeseries({ userId, types, startIso, endIso } = {}) {
      if (!userId || !Array.isArray(types) || types.length === 0 || !startIso || !endIso) {
        throw new Error('getTimeseries requires userId, non-empty types[], startIso, endIso')
      }
      const HARD_PAGE_LIMIT = 1000
      const samples = []
      let cursor
      let more = true
      let pages = 0
      while (more && pages < HARD_PAGE_LIMIT) {
        const res = await request(`/api/v1/users/${encodeURIComponent(userId)}/timeseries`, {
          query: { start_time: startIso, end_time: endIso, types, cursor },
        })
        const page = Array.isArray(res?.data) ? res.data : []
        samples.push(...page)
        pages += 1
        const pagination = res?.pagination || {}
        cursor = pagination.next_cursor
        more = Boolean(pagination.has_more && cursor)
      }
      return samples
    },

    /**
     * Registers (idempotently, from the caller's perspective) a webhook
     * endpoint so OW will POST events to our callback URL. `eventTypes`
     * filters which events fire (omit / empty = all). Returns the
     * EndpointResponse ({ id, url, filter_types, … }).
     */
    async ensureWebhookEndpoint({ url, eventTypes } = {}) {
      if (!url) throw new Error('ensureWebhookEndpoint requires a url')
      return request('/api/v1/webhooks/endpoints', {
        method: 'POST',
        body: {
          url,
          filter_types:
            Array.isArray(eventTypes) && eventTypes.length > 0
              ? eventTypes
              : undefined,
        },
      })
    },
  }
}
