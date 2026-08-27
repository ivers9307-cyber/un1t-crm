// SONOSMOB.4c — api() tags the envelopes it mints ITSELF with
// transport: true, and only those.
//
// A dropped fetch and a non-JSON body are the two cases where api() never
// got a server answer. A polling consumer (SonosControlCard) keeps its last
// good state through one of those rather than painting "Network error"
// for a tick. A real server answer — a JSON { success:false }, or a non-2xx
// without our envelope — DID reach the server and must carry no tag, or
// the card would hide a genuine 401/404 behind stale controls.
//
// Pinned here because the card reads the tag, not a string prefix: if
// api() stops setting it, nothing else in the tree would notice.
//
// RN modules (expo-constants, ./supabase, ./impersonate) are fully
// mocked, so nothing native loads — same harness as
// impersonation-headers.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiBaseUrl: 'https://test.local' } } },
}))

const OK_SESSION = { data: { session: { access_token: 'jwt-1' } } }

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      // vi.fn so MOBILE-SESSION.1's retry can be driven per test; the default
      // implementation is restored in beforeEach so every other case sees a
      // session that simply resolves.
      getSession: vi.fn(async () => OK_SESSION),
    },
  },
}))

vi.mock('./impersonate', () => ({
  readImpersonate: async () => null,
}))

import { api } from './api'
import { supabase } from './supabase'

beforeEach(() => {
  delete global.fetch
  vi.mocked(supabase.auth.getSession).mockReset()
  vi.mocked(supabase.auth.getSession).mockImplementation(async () => OK_SESSION)
})

describe('api() transport tag', () => {
  it('a rejected fetch yields { success:false, transport:true }', async () => {
    global.fetch = vi.fn(async () => { throw new Error('Failed to fetch') })

    const r = await api('/api/anything')

    expect(r.success).toBe(false)
    expect(r.transport).toBe(true)
    expect(r.error).toBe('Network error: Failed to fetch')
  })

  it('a non-JSON body yields { success:false, transport:true }', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    }))

    const r = await api('/api/anything')

    expect(r.success).toBe(false)
    expect(r.transport).toBe(true)
    // GEOFENCE-TRANSPORT.1 — the status rides along so the retry queue can
    // tell an edge 5xx page (retry) from an HTML 404 (don't) by field.
    expect(r.status).toBe(502)
    expect(r.error).toBe('Non-JSON response (502)')
  })

  it('a JSON { success:false } from the server carries NO transport tag', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: 'Schedule not found' }),
    }))

    const r = await api('/api/anything')

    expect(r).toEqual({ success: false, error: 'Schedule not found' })
    expect('transport' in r).toBe(false)
  })

  it('a non-2xx without our envelope is synthesised WITHOUT the tag — it reached the server', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'boom' }),
    }))

    const r = await api('/api/anything')

    // SHELLY-MOB.1 — the status rides along here too, so a caller can tell one
    // non-2xx from another by field rather than by matching the error string.
    expect(r).toEqual({ success: false, status: 500, error: 'HTTP 500' })
    expect('transport' in r).toBe(false)
  })

  it('a non-2xx body that carries our envelope passes through INTACT — the 429 pending case', async () => {
    // POST /api/shelly/devices/<id>/toggle answers HTTP 429 with
    // `success:true, pending:true` when Shelly's shared 1 req/sec budget is
    // spent: the override is written BEFORE the command is sent, so it is
    // saved and the cron will apply it. An explicit `success` boolean means
    // the body IS our envelope — replacing it would render "HTTP 429" for a
    // switch that did not fail. The screen reads the real `pending`/`code`.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ success: true, applied: false, pending: true, code: 'rate_limited' }),
    }))

    const r = await api('/api/anything')

    expect(r).toEqual({ success: true, applied: false, pending: true, code: 'rate_limited' })
    expect('transport' in r).toBe(false)
  })

  it('a non-2xx failure envelope also passes through unreplaced — the 409/429 error bodies', async () => {
    // The toggle's `auto` path (and every 4xx with `{ success:false, error }`)
    // must reach the caller with the route's own copy, not a synthesised
    // "HTTP 409". This was already true before SHELLY-MOB.1 (`success:false`
    // skipped the synthesis); pinned now that the condition is an explicit
    // typeof check.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: 'Connect your Shelly account first', code: 'not_connected' }),
    }))

    const r = await api('/api/anything')

    expect(r).toEqual({ success: false, error: 'Connect your Shelly account first', code: 'not_connected' })
  })
})

describe('api() session guard (MOBILE-SESSION.1)', () => {
  it('a session read that keeps failing answers a transport envelope — and never sends the request', async () => {
    // authHeaders() -> supabase.auth.getSession() is a NETWORK call once the
    // access token has aged out. It used to sit outside every try in api(), so
    // this rejection escaped to the screen, which printed it verbatim: the
    // Hatch Street "JSON Parse error" on a 5G link, with no request ever
    // reaching the server (production logs showed zero toggle hits).
    vi.mocked(supabase.auth.getSession).mockRejectedValue(
      new SyntaxError('JSON Parse error: Unexpected character: <')
    )
    global.fetch = vi.fn()

    const r = await api('/api/shelly/devices/abc/toggle', { method: 'POST', body: { state: 'off' } })

    expect(r.success).toBe(false)
    // Same fact as a dropped fetch: no server answer, nothing was sent. Pollers
    // read this tag to keep their last good rows.
    expect(r.transport).toBe(true)
    expect(r.error).toMatch(/could not refresh your session/)
    expect(r.error).not.toMatch(/JSON Parse error/)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('retries ONCE and proceeds when the second read succeeds — the dropped-packet case', async () => {
    vi.mocked(supabase.auth.getSession)
      .mockRejectedValueOnce(new SyntaxError('JSON Parse error: Unexpected character: <'))
      .mockImplementation(async () => OK_SESSION)
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }))

    const r = await api('/api/anything')

    expect(r).toEqual({ success: true })
    expect(vi.mocked(supabase.auth.getSession)).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    // The retry produced a real token, so the request is authenticated — a
    // retry that silently sent an anonymous request would 401 instead.
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-1')
  })
})
