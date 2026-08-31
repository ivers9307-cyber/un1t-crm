// Sensibo client tests. The audit (item 4.2) called this out as
// one of the highest-leverage untested integration boundaries —
// every AC route on the studio-management surface flows through
// these functions, and a silent regression here would leave staff
// staring at a non-responsive AC card with no obvious cause.
//
// We can't hit the real Sensibo API in tests, so all the network
// calls go through a mocked global.fetch. The pure functions
// (buildTurnOnState, the error class shape) get straight unit
// tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SensiboError,
  buildTurnOnState,
  listPods,
  getPodState,
  setPodState,
  turnPodOff,
  buildTurnOffState,
} from './sensibo.js'

// Helpers --------------------------------------------------------

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

function textResponse(text, { status = 500 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }
}

let originalFetch
beforeEach(() => {
  originalFetch = global.fetch
})
afterEach(() => {
  global.fetch = originalFetch
})

// ----------------------------------------------------------------
// SensiboError
// ----------------------------------------------------------------

describe('SensiboError', () => {
  it('is an instanceof Error', () => {
    const e = new SensiboError('boom')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('SensiboError')
    expect(e.message).toBe('boom')
  })

  it('preserves status + body on the instance', () => {
    const e = new SensiboError('bad', { status: 502, body: { reason: 'x' } })
    expect(e.status).toBe(502)
    expect(e.body).toEqual({ reason: 'x' })
  })
})

// ----------------------------------------------------------------
// buildTurnOnState — pure
// ----------------------------------------------------------------

describe('buildTurnOnState', () => {
  it('uses defaults when args are omitted (cool/18/high)', () => {
    expect(buildTurnOnState({})).toEqual({
      on: true,
      mode: 'cool',
      targetTemperature: 18,
      temperatureUnit: 'C',
      fanLevel: 'high',
      swing: 'stopped',
    })
  })

  it('respects explicit mode/temp/fan', () => {
    expect(buildTurnOnState({ mode: 'heat', temp: 22, fan: 'low' })).toEqual({
      on: true,
      mode: 'heat',
      targetTemperature: 22,
      temperatureUnit: 'C',
      fanLevel: 'low',
      swing: 'stopped',
    })
  })

  it('respects targetTemperature: 0 (falsy but valid)', () => {
    // Defensive: a temp of zero is unusual but shouldn't be
    // silently overridden to 18.
    expect(buildTurnOnState({ temp: 0 }).targetTemperature).toBe(0)
  })

  it('always sets on: true (this is the "turn on" state)', () => {
    expect(buildTurnOnState({}).on).toBe(true)
    expect(buildTurnOnState({ mode: 'fan' }).on).toBe(true)
  })
})

// ----------------------------------------------------------------
// requireApiKey via the fetch wrapper
// ----------------------------------------------------------------

describe('API key validation', () => {
  it('listPods throws SensiboError when api key is missing', async () => {
    await expect(listPods('')).rejects.toThrow(SensiboError)
    await expect(listPods(null)).rejects.toThrow(/api key is missing/i)
  })

  it('getPodState throws SensiboError when podId is missing', async () => {
    await expect(getPodState('key', '')).rejects.toThrow(SensiboError)
    await expect(getPodState('key', null)).rejects.toThrow(/podId is required/i)
  })

  it('setPodState throws SensiboError when podId is missing', async () => {
    await expect(setPodState('key', '', { on: true })).rejects.toThrow(/podId is required/i)
  })
})

// ----------------------------------------------------------------
// listPods
// ----------------------------------------------------------------

describe('listPods', () => {
  it('flattens Sensibo result into the trimmed shape the UI uses', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      status: 'success',
      result: [
        {
          id: 'pod-1',
          room: { name: 'Studio A', icon: 'home' },
          productModel: 'sky',
          acState: { on: true, mode: 'cool', targetTemperature: 18, fanLevel: 'high' },
        },
      ],
    }))
    const out = await listPods('key-xyz')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'pod-1',
      room_name: 'Studio A',
      product_model: 'sky',
      on: true,
      mode: 'cool',
      target_temp: 18,
      fan_level: 'high',
    })
    expect(out[0].raw).toBeDefined()
  })

  it('returns [] when result is missing or empty', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ status: 'success' }))
    expect(await listPods('key')).toEqual([])
  })

  it('puts the apiKey on the URL query string (not as a header)', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ status: 'success', result: [] }))
    await listPods('my-key')
    const url = String(global.fetch.mock.calls[0][0])
    expect(url).toMatch(/apiKey=my-key/)
  })
})

// ----------------------------------------------------------------
// getPodState
// ----------------------------------------------------------------

describe('getPodState', () => {
  it('returns the inner acState object as-is', async () => {
    const acState = { on: true, mode: 'cool', targetTemperature: 18, fanLevel: 'high' }
    global.fetch = vi.fn(async () => jsonResponse({
      status: 'success',
      result: { acState },
    }))
    expect(await getPodState('key', 'pod-1')).toEqual(acState)
  })

  it('returns null when result.acState is missing (defensive)', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ status: 'success', result: {} }))
    expect(await getPodState('key', 'pod-1')).toBeNull()
  })

  it('encodes podId for the URL path', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ status: 'success', result: { acState: {} } }))
    await getPodState('key', 'pod with space')
    const url = String(global.fetch.mock.calls[0][0])
    expect(url).toMatch(/\/pods\/pod%20with%20space/)
  })
})

// ----------------------------------------------------------------
// setPodState
// ----------------------------------------------------------------

describe('setPodState', () => {
  it('POSTs the desired state under { acState } and returns the response', async () => {
    const desired = { on: true, mode: 'cool', targetTemperature: 18 }
    const observed = { ...desired, fanLevel: 'high' }
    global.fetch = vi.fn(async () => jsonResponse({
      status: 'success',
      result: { acState: observed },
    }))
    const out = await setPodState('key', 'pod-1', desired)
    expect(out).toEqual(observed)

    const [, init] = global.fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ acState: desired })
  })

  it('falls back to the desired state when Sensibo omits result.acState', async () => {
    const desired = { on: false }
    global.fetch = vi.fn(async () => jsonResponse({ status: 'success', result: {} }))
    expect(await setPodState('key', 'pod-1', desired)).toEqual(desired)
  })
})

// ----------------------------------------------------------------
// turnPodOff
// ----------------------------------------------------------------

describe('turnPodOff', () => {
  it('SENSIBO-RATE.1: with an offState it is ONE call — no state read', async () => {
    // This is the whole point of the change. The auto-off cron loops
    // expired sessions, and a GET+POST per row is exactly the
    // back-to-back pattern Sensibo's burst limiter punishes.
    const offState = buildTurnOffState({ mode: 'cool', temp: 18, fan: 'high' })
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({ status: 'success', result: { acState: offState } })
    )

    const out = await turnPodOff('key', 'pod-1', offState)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = global.fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(String(url)).toContain('/pods/pod-1/acStates')
    expect(JSON.parse(init.body).acState).toMatchObject({
      on: false, mode: 'cool', targetTemperature: 18, fanLevel: 'high',
    })
    expect(out.on).toBe(false)
  })

  it('SENSIBO-RATE.1: forces on:false even if the caller passes a state that says on:true', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({ status: 'success', result: { acState: { on: false } } })
    )
    await turnPodOff('key', 'pod-1', { on: true, mode: 'heat', targetTemperature: 25 })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).acState.on).toBe(false)
  })

  it('falls back to read-then-write when no offState is supplied', async () => {
    const current = { on: true, mode: 'cool', targetTemperature: 18, fanLevel: 'high' }
    global.fetch = vi.fn()
      // first call: getPodState → returns current
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: { acState: current } }))
      // second call: setPodState → returns the new state
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        result: { acState: { ...current, on: false } },
      }))

    const out = await turnPodOff('key', 'pod-1')
    expect(out).toEqual({ ...current, on: false })

    // Second call should be a POST with on:false but everything
    // else preserved — important so the next "turn on" doesn't
    // come up at a different target temp.
    const [, init] = global.fetch.mock.calls[1]
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.acState.on).toBe(false)
    expect(body.acState.mode).toBe('cool')
    expect(body.acState.targetTemperature).toBe(18)
    expect(body.acState.fanLevel).toBe('high')
  })

  it('handles a null current state (writes just on:false)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: {} })) // null acState
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: { acState: { on: false } } }))
    const out = await turnPodOff('key', 'pod-1')
    expect(out).toEqual({ on: false })
  })
})

// ----------------------------------------------------------------
// Error handling — surfaces Sensibo's status + body verbatim
// ----------------------------------------------------------------

describe('error handling', () => {
  it('throws SensiboError with status + Sensibo message on non-2xx', async () => {
    global.fetch = vi.fn(async () => jsonResponse(
      { status: 'failure', message: 'Pod not found' },
      { status: 404 }
    ))
    await expect(getPodState('key', 'pod-1')).rejects.toMatchObject({
      name: 'SensiboError',
      status: 404,
      message: 'Pod not found',
    })
  })

  it('throws SensiboError on non-2xx with non-JSON body', async () => {
    global.fetch = vi.fn(async () => textResponse('Internal Server Error', { status: 500 }))
    await expect(getPodState('key', 'pod-1')).rejects.toMatchObject({
      name: 'SensiboError',
      status: 500,
    })
  })

  it('throws SensiboError when 200 but body says status: failure', async () => {
    // Sensibo sometimes returns 200 with status: 'failure' inline.
    global.fetch = vi.fn(async () => jsonResponse({
      status: 'failure',
      reason: 'Quota exceeded',
    }))
    await expect(getPodState('key', 'pod-1')).rejects.toMatchObject({
      name: 'SensiboError',
      message: 'Quota exceeded',
    })
  })

  it('wraps fetch network errors as SensiboError with status: 0', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    const err = await getPodState('key', 'pod-1').catch(e => e)
    expect(err).toBeInstanceOf(SensiboError)
    expect(err.status).toBe(0)
    expect(err.message).toMatch(/network error/i)
    expect(err.message).toMatch(/ECONNRESET/)
  })
})
