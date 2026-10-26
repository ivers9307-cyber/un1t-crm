// @vitest-environment jsdom
//
// SHELLY-UI.6 — the page root, and the three states its two reads can be in.
//
// The assertions here exist because of a specific pair of route decisions:
// GET /api/shelly/connection answers 500 (not `connection: null`) on a
// transient database error, and GET /api/shelly/devices answers
// `connected: null` + `connection_status: 'unknown'` in the same situation —
// both so that a live studio is NEVER handed "not connected". A client that
// blanked itself, or fell back to the Connect form, would rebuild that exact
// failure one layer up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent, within } from '@testing-library/react'
import ShellyDevicesClient, { refreshSummary, syncNamesSummary } from './ShellyDevicesClient.jsx'

const CONNECTION = {
  host: 'shelly-68-eu.shelly.cloud',
  has_auth_key: true,
  status: 'connected',
  last_ok_at: new Date(Date.now() - 60_000).toISOString(),
  last_error: null,
  last_error_at: null,
}

const DEVICE = {
  id: 'row-1',
  location_id: 'loc-1',
  device_id: 'aabbccddeeff',
  channel: 0,
  name: 'Sauna plug',
  model: 'SNPL-00112EU',
  gen: 2,
  zone: null,
  enabled: false,
  schedule_mode: 'none',
  fixed_windows: [],
  class_rule: {},
  override: null,
  last_applied: null,
  last_state: { online: true, output: false, apower: 0, aenergy_wh: 10, temperature_c: 30, source: 'schedule', at: new Date().toISOString() },
  last_seen_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

// A scripted pair of answers per poll round. Each entry is [connectionReply,
// devicesReply]; the last entry repeats.
function script(rounds) {
  let round = 0
  const seen = { connection: 0, devices: 0 }
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (u === '/api/shelly/refresh') return json(200, { success: true, refreshed: 3, read_failures: 0, rate_limited: 0, kind: null })
    const pair = rounds[Math.min(round, rounds.length - 1)]
    if (u === '/api/shelly/connection' && (!init.method || init.method === 'GET')) {
      seen.connection += 1
      return pair[0]
    }
    if (u === '/api/shelly/devices') {
      seen.devices += 1
      // Both legs of a round are issued together; advance once both landed.
      if (seen.devices > round) round += 1
      return pair[1]
    }
    return json(200, { success: true })
  })
  return seen
}

const okConn = (over = {}) => json(200, { success: true, connection: CONNECTION, can_manage: true, device_count: 1, ...over })
const okDevices = (over = {}) => json(200, { success: true, devices: [DEVICE], connected: true, connection_status: 'connected', ...over })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch; vi.useRealTimers() })

describe('ShellyDevicesClient — the happy path', () => {
  it('loads both reads in parallel on mount and renders a card per device', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    const urls = global.fetch.mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('/api/shelly/connection')
    expect(urls).toContain('/api/shelly/devices')
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Find devices/ })).toBeTruthy()
  })

  it('trusts the server’s can_manage over the page’s prop once loaded', async () => {
    script([[okConn({ can_manage: false }), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText(/Managed by the studio owner/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Re-paste key/ })).toBeNull()
  })
})

// PROFILESPREAD.1a — the page could not read the Glofox status; the flag
// travels to every card's schedule editor, so none of them says "Connect Glofox".
describe('ShellyDevicesClient — Glofox status unknown', () => {
  it('passes glofoxUnknown through to each card\'s schedule editor', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected={false} glofoxUnknown canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    const radio = screen.getByLabelText('Follow classes')
    expect(radio.disabled).toBe(true)
    expect(radio.closest('label').getAttribute('title')).toBe("Couldn't check Glofox. Reload to try again.")
  })
})

describe('ShellyDevicesClient — the three connection states', () => {
  it('connection_status null shows the Connect form and no cards', async () => {
    script([[json(200, { success: true, connection: null, can_manage: true, device_count: 0 }),
      json(200, { success: true, devices: [], connected: false, connection_status: null })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy())
    expect(screen.queryByText('Sauna plug')).toBeNull()
    // Discovery needs a live connection.
    expect(screen.queryByRole('button', { name: /Find devices/ })).toBeNull()
  })

  it('connection_status "unknown" KEEPS the cards, keeps the controls, and never offers the Connect form', async () => {
    script([[json(500, { success: false, error: 'Could not read the Shelly connection' }),
      json(200, { success: true, devices: [DEVICE], connected: null, connection_status: 'unknown' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)

    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    expect(screen.getByText('Couldn’t read the Shelly connection — retrying')).toBeTruthy()
    // ONE line about it, not two — the specific message replaces the generic.
    expect(screen.queryByText('Couldn’t refresh — retrying')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
    // Controls stay live: it is OUR read that failed, not the plug.
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
    // And the health grade never reaches red on an unknown connection.
    expect(screen.queryByText(/Stale/)).toBeNull()
  })

  it('action_needed and error are rendered as themselves, not as "not connected"', async () => {
    script([[okConn({ connection: { ...CONNECTION, status: 'action_needed', last_error: 'Shelly rejected the stored auth key' } }),
      okDevices({ connected: false, connection_status: 'action_needed' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Action needed — re-paste the key')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Find devices/ })).toBeNull()
  })
})

describe('ShellyDevicesClient — a failed poll keeps the last good render', () => {
  it('keeps the cards and the connection panel, adding only a subordinate line', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [okConn(), okDevices()],
      [json(500, { success: false, error: 'Could not read the Shelly connection' }),
        json(500, { success: false, error: 'Could not load your Shelly devices' })],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())
    // NOTHING was blanked.
    expect(screen.getByText('Sauna plug')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
  })

  it('clears the line as soon as a poll works again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [okConn(), okDevices()],
      [json(500, { success: false }), json(500, { success: false })],
      [okConn(), okDevices()],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.queryByText('Couldn’t refresh — retrying')).toBeNull())
  })

  it('a first load that fails entirely says so — no Connect form, and NO claim about the plugs', async () => {
    script([[json(500, { success: false }), json(500, { success: false })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Couldn’t read the Shelly connection — retrying')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
    // "No devices adopted yet" is a statement about the STUDIO. We did not read
    // the devices, so we are not entitled to make it.
    expect(screen.queryByText(/No devices adopted yet/)).toBeNull()
  })

  it('claims "no plugs" only once the devices read has actually succeeded', async () => {
    script([[okConn(), okDevices({ devices: [] })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText(/No devices adopted yet/)).toBeTruthy())
  })

  it('a devices read that fails while the connection reads fine makes no claim either', async () => {
    script([[okConn(), json(500, { success: false, error: 'Could not load your Shelly devices' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())
    expect(screen.queryByText(/No devices adopted yet/)).toBeNull()
    // The connection panel is unaffected — that read worked.
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('LAST ISSUED wins, not last arrived: a slow earlier poll cannot repaint a newer load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // Round 1's devices leg is held open until after round 2 has landed.
    let releaseFirst = null
    const firstDevices = new Promise((resolve) => { releaseFirst = resolve })
    let devicesCalls = 0
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u === '/api/shelly/connection') return okConn()
      if (u === '/api/shelly/devices') {
        devicesCalls += 1
        if (devicesCalls === 1) return firstDevices
        return okDevices({ devices: [{ ...DEVICE, name: 'NEW name' }] })
      }
      return json(200, { success: true })
    })

    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    // Round 2 (the poll tick) resolves first and paints.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.getByText('NEW name')).toBeTruthy())

    // Round 1 finally answers with the STALE row. It must be dropped.
    await act(async () => {
      releaseFirst(okDevices({ devices: [{ ...DEVICE, name: 'STALE name' }] }))
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('NEW name')).toBeTruthy())
    expect(screen.queryByText('STALE name')).toBeNull()
  })

  it('polls on a 30 s tick and stops while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const seen = script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(seen.devices).toBe(1))

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(seen.devices).toBe(2))

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(seen.devices).toBe(2)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(seen.devices).toBe(3))
  })
})

describe('refreshSummary — worded off all three counters', () => {
  it('zero changed rows is the HEALTHY answer for a studio nothing moved in', () => {
    // `refreshed` counts rows whose state CHANGED, and the deadband swallows a
    // wattmeter twitching in the third decimal — "Refreshed 0 devices" read as
    // a failure.
    expect(refreshSummary({ refreshed: 0, read_failures: 0, rate_limited: 0 }))
      .toEqual({ tone: 'ok', text: 'No changes' })
  })

  it('counts and singularises what did change', () => {
    expect(refreshSummary({ refreshed: 1 }).text).toBe('Updated 1 device')
    expect(refreshSummary({ refreshed: 4 }).text).toBe('Updated 4 devices')
  })

  it('names unread plugs, in a warning tone', () => {
    expect(refreshSummary({ refreshed: 2, read_failures: 1 }))
      .toEqual({ tone: 'warn', text: 'Updated 2 devices — 1 couldn’t be read' })
  })

  it('explains a quiet result when Shelly was busy', () => {
    expect(refreshSummary({ refreshed: 0, rate_limited: 3 }).text).toBe('No changes — Shelly was busy')
  })

  it('stays quiet about a rate limit that did not stop anything', () => {
    // A 429 that was retried into a success is invisible to the operator by
    // design — mentioning it would invite action on a non-problem.
    expect(refreshSummary({ refreshed: 5, rate_limited: 2 }).text).toBe('Updated 5 devices')
  })

  it('says all of it at once when all of it happened', () => {
    expect(refreshSummary({ refreshed: 0, read_failures: 2, rate_limited: 1 }))
      .toEqual({ tone: 'warn', text: 'No changes — Shelly was busy — 2 couldn’t be read' })
  })

  it('an absent body is not a crash', () => {
    expect(refreshSummary()).toEqual({ tone: 'ok', text: 'No changes' })
  })
})

describe('ShellyDevicesClient — the status derivation under a later failure', () => {
  it('a confident "never connected" SURVIVES a later 500 — the Connect form stays', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [json(200, { success: true, connection: null, can_manage: true, device_count: 0 }),
        json(200, { success: true, devices: [], connected: false, connection_status: null })],
      [json(500, { success: false }), json(500, { success: false })],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    // The last GOOD read said "not connected", and that is still the last
    // thing we actually know — so the form stays and the failure is
    // subordinate.
    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy()
    expect(screen.queryByText('Couldn’t read the Shelly connection — retrying')).toBeNull()
  })

  it('a live studio whose connection read then fails keeps its panel, not the unreadable card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [okConn(), okDevices()],
      [json(500, { success: false }),
        json(200, { success: true, devices: [DEVICE], connected: null, connection_status: 'unknown' })],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())
    // The last-good connection is authoritative over the devices payload's
    // 'unknown', so this is the GENERIC retry line over a live panel — not the
    // "couldn't read the connection" card, which is for having nothing at all.
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByText('Couldn’t read the Shelly connection — retrying')).toBeNull()
    expect(screen.getByText('Sauna plug')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
  })
})

describe('ShellyDevicesClient — refresh', () => {
  it('reports the refreshed count and then debounces the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    const button = screen.getByRole('button', { name: /Refresh/ })
    await act(async () => { button.click() })
    await waitFor(() => expect(screen.getByText('Updated 3 devices')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await waitFor(() => expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(false))
  })

  it('the verdict clears itself rather than standing over whatever happens next', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    await act(async () => { screen.getByRole('button', { name: /Refresh/ }).click() })
    await waitFor(() => expect(screen.getByText('Updated 3 devices')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    await waitFor(() => expect(screen.queryByText('Updated 3 devices')).toBeNull())
  })

  it('renders the route’s own error for a failed refresh', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    global.fetch.mockImplementation(async (url) => (String(url) === '/api/shelly/refresh'
      ? json(429, { success: false, error: 'Shelly is busy — try again in a few seconds', code: 'rate_limited' })
      : json(200, { success: true, devices: [DEVICE], connected: true, connection_status: 'connected' })))

    await act(async () => { screen.getByRole('button', { name: /Refresh/ }).click() })
    await waitFor(() => expect(screen.getByText('Shelly is busy — try again in a few seconds')).toBeTruthy())
  })
})

// ——— SHELLY-NAMES.1 — "Use Shelly names" ————————————————————————————

describe('syncNamesSummary', () => {
  it('leads with what the operator can see the effect of', () => {
    expect(syncNamesSummary({ total: 6, updated: 6 })).toEqual({ tone: 'ok', text: 'Named 6 of 6' })
  })

  it('never folds "Shelly has no name for it" into "no changes" — they are different answers', () => {
    // The live failure this button exists for. A warn tone, because it is the
    // one outcome that needs someone to look.
    expect(syncNamesSummary({ total: 6, updated: 0, unresolved: 6 }))
      .toEqual({ tone: 'warn', text: 'No names found in Shelly for 6 plugs' })
    expect(syncNamesSummary({ total: 1, unresolved: 1 }).text).toBe('No names found in Shelly for 1 plug')
    // …and it is still said when some plugs DID resolve.
    expect(syncNamesSummary({ total: 6, updated: 4, unresolved: 2 }))
      .toEqual({ tone: 'warn', text: 'Named 4 of 6 — no name in Shelly for 2 plugs' })
  })

  it('a location whose names already match is a quiet, healthy answer', () => {
    expect(syncNamesSummary({ total: 6, unchanged: 6 })).toEqual({ tone: 'ok', text: 'Names already match' })
    expect(syncNamesSummary()).toEqual({ tone: 'ok', text: 'Names already match' })
  })

  it('says the two ways it can be incomplete', () => {
    expect(syncNamesSummary({ total: 6, updated: 5, write_failures: 1 }))
      .toEqual({ tone: 'warn', text: 'Named 5 of 6 — 1 couldn’t be saved' })
    expect(syncNamesSummary({ total: 12, updated: 10, partial: true }))
      .toEqual({ tone: 'warn', text: 'Named 10 of 12 — some plugs weren’t checked' })
  })
})

describe('ShellyDevicesClient — Use Shelly names', () => {
  const withSync = (reply) => {
    global.fetch.mockImplementation(async (url) => {
      const u = String(url)
      if (u === '/api/shelly/sync-names') return reply
      if (u === '/api/shelly/connection') return okConn()
      return okDevices()
    })
  }

  const openSync = async () => {
    await act(async () => { screen.getByRole('button', { name: /Use Shelly names/ }).click() })
  }

  it('is hidden when the studio has no plugs — there is nothing to name', async () => {
    script([[okConn(), okDevices({ devices: [] })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText(/No devices adopted yet/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Use Shelly names/ })).toBeNull()
  })

  it('is hidden without a live connection — the route could only 409', async () => {
    script([[okConn({ connection: { ...CONNECTION, status: 'action_needed' } }),
      okDevices({ connected: false, connection_status: 'action_needed' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Use Shelly names/ })).toBeNull()
    // Refresh is unaffected — it reads state we already hold rows for.
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
  })

  it('asks before it acts, and the safe choice posts overwrite:false', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    // Nothing is posted by opening the confirm.
    withSync(json(200, { success: true, total: 6, updated: 4, unchanged: 2, unresolved: 0, write_failures: 0 }))
    await openSync()
    expect(global.fetch.mock.calls.map((c) => String(c[0]))).not.toContain('/api/shelly/sync-names')

    await act(async () => { screen.getByRole('button', { name: /Only unnamed plugs/ }).click() })
    await waitFor(() => expect(screen.getByText('Named 4 of 6')).toBeTruthy())

    const call = global.fetch.mock.calls.find((c) => String(c[0]) === '/api/shelly/sync-names')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ overwrite: false })
    // The confirm closes once it has been acted on.
    expect(screen.queryByRole('button', { name: /Only unnamed plugs/ })).toBeNull()
  })

  it('the destructive choice says what it replaces, and posts overwrite:true', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    withSync(json(200, { success: true, total: 6, updated: 6, unchanged: 0, unresolved: 0, write_failures: 0 }))
    await openSync()
    await act(async () => { screen.getByRole('button', { name: /All plugs — replaces names typed here/ }).click() })
    await waitFor(() => expect(screen.getByText('Named 6 of 6')).toBeTruthy())

    const call = global.fetch.mock.calls.find((c) => String(c[0]) === '/api/shelly/sync-names')
    expect(JSON.parse(call[1].body)).toEqual({ overwrite: true })
  })

  it('renders the unresolved verdict — the answer this button was built to surface', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    withSync(json(200, { success: true, total: 6, updated: 0, unchanged: 0, unresolved: 6, write_failures: 0 }))
    await openSync()
    await act(async () => { screen.getByRole('button', { name: /Only unnamed plugs/ }).click() })
    await waitFor(() => expect(screen.getByText('No names found in Shelly for 6 plugs')).toBeTruthy())
  })

  it('debounces afterwards, on its own clock rather than Refresh’s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    withSync(json(200, { success: true, total: 1, updated: 1 }))
    await openSync()
    await act(async () => { screen.getByRole('button', { name: /Only unnamed plugs/ }).click() })
    await waitFor(() => expect(screen.getByRole('button', { name: /Use Shelly names/ }).disabled).toBe(true))
    // Refresh is NOT disabled by a name sync — one shared flag would leave an
    // operator staring at a dead button with no explanation.
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await waitFor(() => expect(screen.getByRole('button', { name: /Use Shelly names/ }).disabled).toBe(false))
  })

  it('a PARTIAL failure still reports the names that landed', async () => {
    // The route writes what it resolved before reporting the failure, so a
    // bare error line would tell an operator nothing happened when ten plugs
    // were in fact renamed.
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    withSync(json(502, {
      success: false, error: 'Shelly stopped answering — some plugs were not checked',
      code: 'network', partial: true, total: 12, updated: 10,
    }))
    await openSync()
    await act(async () => { screen.getByRole('button', { name: /Only unnamed plugs/ }).click() })
    await waitFor(() => expect(screen.getByText(/^Named 10 — Shelly stopped answering/)).toBeTruthy())
  })

  it('renders the route’s own error when nothing landed', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    withSync(json(409, { success: false, error: 'Shelly rejected the stored key — re-paste it from the Shelly app', code: 'key_rejected' }))
    await openSync()
    await act(async () => { screen.getByRole('button', { name: /Only unnamed plugs/ }).click() })
    await waitFor(() => expect(screen.getByText('Shelly rejected the stored key — re-paste it from the Shelly app')).toBeTruthy())
  })
})

// ——— SHELLYGROUPS.8 — the page redesign ——————————————————————————————
describe('ShellyDevicesClient — groups first, then "Not in a group"', () => {
  const G = (over) => ({
    icon: 'bulb', enabled: false, schedule_mode: 'none', fixed_windows: [], class_rule: {}, override: null,
    device_ids: [], now: { on_count: 0, member_count: 0, mode: 'none', until: null, next_on: null }, ...over,
  })
  const FRONT = { ...DEVICE, id: 'row-2', device_id: '112233445566', name: 'Front light', group_id: 'g-b' }
  const UNGROUPED = { ...DEVICE, group_id: null }

  // One fetch for every route the page reads. `groups` is mutable so a test
  // can change what the next GET answers.
  function page({ groups, devices = [UNGROUPED, FRONT], discover = json(200, { success: true, devices: [] }), onPost } = {}) {
    const state = { groups }
    global.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url)
      const method = init.method || 'GET'
      if (u === '/api/shelly/connection') return okConn()
      if (u === '/api/shelly/devices') return okDevices({ devices })
      if (u === '/api/shelly/groups' && method === 'GET') return json(200, { success: true, groups: state.groups })
      if (u === '/api/shelly/groups' && method === 'POST') return onPost(JSON.parse(init.body), state)
      if (u === '/api/shelly/discover') return typeof discover === 'function' ? discover() : discover
      if (u.startsWith('/api/shelly/preview')) return json(200, { success: true, date: '2026-10-26', groups: [], classes: [] })
      return json(200, { success: true })
    })
    return state
  }

  const twoGroups = () => [
    G({ id: 'g-a', name: 'Zeta', sort_order: 2 }),
    G({ id: 'g-b', name: 'Studio lights', sort_order: 1, device_ids: ['row-2'], now: { on_count: 0, member_count: 1, mode: 'none', until: null, next_on: null } }),
    G({ id: 'g-c', name: 'Alpha', sort_order: 2 }),
  ]

  // Each group card's one switch (role=button + aria-pressed, labelled "<name>: <state>").
  const groupSwitches = () => screen.getAllByRole('button').filter((b) => /^[^:]+: (On|Off|No devices|\d+ of \d+ on)$/.test(b.getAttribute('aria-label') || ''))

  it('lists the group cards by sort_order then name, then the ungrouped devices', async () => {
    page({ groups: twoGroups() })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Studio lights: / })).toBeTruthy())
    const order = groupSwitches().map((s) => s.getAttribute('aria-label').split(':')[0])
    expect(order).toEqual(['Studio lights', 'Alpha', 'Zeta'])

    const notGrouped = screen.getByRole('region', { name: 'Not in a group' })
    expect(within(notGrouped).getByText('Sauna plug')).toBeTruthy()
    // A grouped device is not in the ungrouped section.
    expect(within(notGrouped).queryByText('Front light')).toBeNull()
    // The group cards come before the ungrouped section in the document.
    const firstSwitch = groupSwitches()[0]
    expect(firstSwitch.compareDocumentPosition(notGrouped) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a grouped device\'s own card says which group it follows', async () => {
    page({ groups: twoGroups() })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Devices in groups/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Devices in groups/ }))
    expect(screen.getByText('Follows Studio lights')).toBeTruthy()
  })

  it('"New group" creates through POST and the card appears without a reload', async () => {
    const state = page({
      groups: [],
      onPost: (body, st) => {
        const created = G({ id: 'g-new', name: body.name, sort_order: 0 })
        st.groups = [created]
        return json(201, { success: true, group: { ...created, now: undefined } })
      },
    })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'New group' }))
    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Changing rooms' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Changing rooms: / })).toBeTruthy())
    const post = global.fetch.mock.calls.find(([u, i]) => String(u) === '/api/shelly/groups' && i?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ name: 'Changing rooms' })
    expect(state.groups).toHaveLength(1)
  })

  it('a taken name keeps the form open and says so', async () => {
    page({ groups: [], onPost: () => json(409, { success: false, error: 'A group with that name already exists here', code: 'name_taken' }) })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'New group' }))
    fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Fans' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A group with that name already exists'))
    expect(screen.getByLabelText('New group name')).toBeTruthy()
  })

  it('a banner counts the supported devices on the account that are not set up here', async () => {
    page({
      groups: [],
      discover: json(200, {
        success: true,
        devices: [
          { device_id: 'x1', channel: 0, supported: true, adopted: null },
          { device_id: 'x2', channel: 0, supported: true, adopted: null },
          { device_id: 'x3', channel: 0, supported: true, adopted: 'here' },
          { device_id: 'x4', channel: 0, supported: true, adopted: 'elsewhere' },
          { device_id: 'x5', channel: 0, supported: false, adopted: null },
          { device_id: 'x6', channel: 0, supported: null, adopted: null },
        ],
      }),
    })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText(/2 devices on your Shelly account aren.t set up here/)).toBeTruthy())
    const link = screen.getByRole('link', { name: /Set them up/ })
    expect(link.getAttribute('href')).toBe('#shelly-discover')
    expect(document.getElementById('shelly-discover')).toBeTruthy()
  })

  it('reads discover ONCE per page open, never on the 30 s poll', async () => {
    vi.useFakeTimers()
    page({ groups: [], discover: json(200, { success: true, devices: [{ device_id: 'x1', channel: 0, supported: true, adopted: null }] }) })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/1 device on your Shelly account isn.t set up here/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    const discovers = global.fetch.mock.calls.filter(([u]) => String(u) === '/api/shelly/discover')
    const devicesReads = global.fetch.mock.calls.filter(([u]) => String(u) === '/api/shelly/devices')
    expect(devicesReads.length).toBeGreaterThanOrEqual(3)
    expect(discovers).toHaveLength(1)
  })

  it('a failed discover just hides the banner', async () => {
    page({ groups: [], discover: json(502, { success: false, error: 'Shelly cloud is not answering' }) })
    render(<ShellyDevicesClient locationName="Stillorgan" locationTz="Europe/Dublin" glofoxConnected canManageConnection />)
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u) === '/api/shelly/discover')).toBe(true))
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    expect(screen.queryByText(/on your Shelly account/)).toBeNull()
  })
})
