// LG ThinQ Connect client tests. Same testing posture as
// src/lib/sensibo.test.js — every AC route on the studio-management
// surface flows through these functions and a silent regression
// here would leave staff staring at a non-responsive bathroom AC
// card with no obvious cause.
//
// All network calls go through a mocked global.fetch. Pure
// functions (buildTurnOnState, the error class shape, the
// normalise/lowercase helpers exercised indirectly) get straight
// unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ThinqError,
  buildTurnOnState,
  listDevices,
  getDeviceState,
  setDeviceState,
  turnOff,
} from './thinq.js'

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

const CTX = { pat: 'pat-xyz', clientId: 'client-uuid', countryCode: 'IE' }

let originalFetch
beforeEach(() => {
  originalFetch = global.fetch
})
afterEach(() => {
  global.fetch = originalFetch
})

// ----------------------------------------------------------------
// ThinqError
// ----------------------------------------------------------------

describe('ThinqError', () => {
  it('is an instanceof Error', () => {
    const e = new ThinqError('boom')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ThinqError')
    expect(e.message).toBe('boom')
  })

  it('preserves status, code, body on the instance', () => {
    const e = new ThinqError('bad', { status: 502, code: '1209', body: { x: 1 } })
    expect(e.status).toBe(502)
    expect(e.code).toBe('1209')
    expect(e.body).toEqual({ x: 1 })
  })
})

// ----------------------------------------------------------------
// buildTurnOnState — pure
// ----------------------------------------------------------------

describe('buildTurnOnState', () => {
  it('uses defaults when args are omitted (cool/22/AUTO)', () => {
    expect(buildTurnOnState({})).toEqual({
      operation:     { airConOperationMode: 'POWER_ON' },
      airConJobMode: { currentJobMode: 'COOL' },
      temperature:   { targetTemperatureC: 22 },
      airFlow:       { windStrength: 'AUTO' },
    })
  })

  it('upcases lowercase Sensibo-style mode + fan to LG enums', () => {
    expect(buildTurnOnState({ mode: 'heat', tempC: 24, fan: 'high' })).toEqual({
      operation:     { airConOperationMode: 'POWER_ON' },
      airConJobMode: { currentJobMode: 'HEAT' },
      temperature:   { targetTemperatureC: 24 },
      airFlow:       { windStrength: 'HIGH' },
    })
  })

  it("maps Sensibo's 'medium' fan onto LG's 'MID'", () => {
    expect(buildTurnOnState({ fan: 'medium' }).airFlow.windStrength).toBe('MID')
  })

  it("maps 'quiet' → LOW and 'strong' → HIGH (LG has no exact match)", () => {
    expect(buildTurnOnState({ fan: 'quiet' }).airFlow.windStrength).toBe('LOW')
    expect(buildTurnOnState({ fan: 'strong' }).airFlow.windStrength).toBe('HIGH')
  })

  it('falls back to COOL for an unknown mode (defensive)', () => {
    expect(buildTurnOnState({ mode: 'nonsense' }).airConJobMode.currentJobMode).toBe('COOL')
  })

  it('falls back to AUTO for an unknown fan (defensive)', () => {
    expect(buildTurnOnState({ fan: 'nonsense' }).airFlow.windStrength).toBe('AUTO')
  })

  it('respects tempC: 0 without overriding to 22 (defensive)', () => {
    expect(buildTurnOnState({ tempC: 0 }).temperature.targetTemperatureC).toBe(0)
  })

  it('always sets POWER_ON (this is the "turn on" state builder)', () => {
    expect(buildTurnOnState({}).operation.airConOperationMode).toBe('POWER_ON')
    expect(buildTurnOnState({ mode: 'fan' }).operation.airConOperationMode).toBe('POWER_ON')
  })
})

// ----------------------------------------------------------------
// Auth + arg validation via the fetch wrapper
// ----------------------------------------------------------------

describe('credential validation', () => {
  it('listDevices throws ThinqError when PAT is missing', async () => {
    await expect(listDevices({ pat: '', clientId: 'cid' })).rejects.toThrow(ThinqError)
    await expect(listDevices({ pat: null, clientId: 'cid' })).rejects.toThrow(/PAT is missing/i)
  })

  it('listDevices throws ThinqError when client_id is missing', async () => {
    await expect(listDevices({ pat: 'p', clientId: '' })).rejects.toThrow(/client_id is missing/i)
  })

  it('getDeviceState throws ThinqError when deviceId is missing', async () => {
    await expect(getDeviceState('', CTX)).rejects.toThrow(/deviceId is required/i)
    await expect(getDeviceState(null, CTX)).rejects.toThrow(ThinqError)
  })

  it('setDeviceState throws ThinqError when deviceId is missing', async () => {
    await expect(setDeviceState('', { op: 1 }, CTX)).rejects.toThrow(/deviceId is required/i)
  })

  it('setDeviceState throws ThinqError when command body is missing', async () => {
    await expect(setDeviceState('dev-1', null, CTX)).rejects.toThrow(/command body is required/i)
  })
})

// ----------------------------------------------------------------
// listDevices
// ----------------------------------------------------------------

describe('listDevices', () => {
  it('filters to AC devices and flattens into the trimmed shape', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      messageId: 'm-1',
      response: [
        {
          deviceId: 'ac-1',
          deviceInfo: { alias: 'Bathroom M', modelName: 'LG-XYZ', deviceType: 'DEVICE_AIR_CONDITIONER' },
        },
        {
          deviceId: 'wash-1',
          deviceInfo: { alias: 'Washer', modelName: 'LG-W', deviceType: 'DEVICE_WASHER' },
        },
        {
          deviceId: 'ac-2',
          deviceInfo: { alias: 'Bathroom F', modelName: 'LG-XYZ', deviceType: 'DEVICE_AIR_CONDITIONER' },
        },
      ],
    }))
    const out = await listDevices(CTX)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      device_id: 'ac-1',
      alias: 'Bathroom M',
      model: 'LG-XYZ',
      device_type: 'DEVICE_AIR_CONDITIONER',
    })
    expect(out[1].device_id).toBe('ac-2')
    expect(out[0].raw).toBeDefined()
  })

  it('returns [] when response is missing or empty', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ messageId: 'm' }))
    expect(await listDevices(CTX)).toEqual([])
  })

  it("sends PAT as a Bearer header (not query string, unlike Sensibo)", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ response: [] }))
    await listDevices(CTX)
    const [, init] = global.fetch.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer pat-xyz')
    const url = String(global.fetch.mock.calls[0][0])
    expect(url).not.toMatch(/pat-xyz/)  // never on the URL
  })

  it('sends X-Country + X-Client-ID + X-Message-ID headers', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ response: [] }))
    await listDevices(CTX)
    const [, init] = global.fetch.mock.calls[0]
    expect(init.headers['X-Country']).toBe('IE')
    expect(init.headers['X-Client-ID']).toBe('client-uuid')
    expect(init.headers['X-Message-ID']).toMatch(/[0-9a-f-]+/i)
  })
})

// ----------------------------------------------------------------
// getDeviceState — response normalisation
// ----------------------------------------------------------------

describe('getDeviceState', () => {
  it('normalises a powered-on cool state', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      response: {
        operation: { airConOperationMode: 'POWER_ON' },
        airConJobMode: { currentJobMode: 'COOL' },
        temperature: { targetTemperatureC: 22, currentTemperatureC: 24 },
        airFlow: { windStrength: 'HIGH' },
      },
    }))
    const s = await getDeviceState('ac-1', CTX)
    expect(s).toMatchObject({
      on: true,
      mode: 'cool',
      target_temp_c: 22,
      current_temp_c: 24,
      fan: 'high',
    })
    expect(s.raw).toBeDefined()
  })

  it("translates LG's 'MID' fan strength back to 'medium'", async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      response: {
        operation: { airConOperationMode: 'POWER_ON' },
        airConJobMode: { currentJobMode: 'COOL' },
        temperature: { targetTemperatureC: 20 },
        airFlow: { windStrength: 'MID' },
      },
    }))
    expect((await getDeviceState('ac-1', CTX)).fan).toBe('medium')
  })

  it('returns on=false when device is in POWER_OFF', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      response: {
        operation: { airConOperationMode: 'POWER_OFF' },
      },
    }))
    expect((await getDeviceState('ac-1', CTX)).on).toBe(false)
  })

  it('returns null when LG response is null (defensive)', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ messageId: 'm' }))
    expect(await getDeviceState('ac-1', CTX)).toBeNull()
  })

  it('encodes deviceId for the URL path', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ response: {} }))
    await getDeviceState('dev with space', CTX)
    const url = String(global.fetch.mock.calls[0][0])
    expect(url).toMatch(/\/devices\/dev%20with%20space\/state/)
  })
})

// ----------------------------------------------------------------
// setDeviceState + turnOff
// ----------------------------------------------------------------

describe('setDeviceState', () => {
  it('POSTs the command body and returns the normalised response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      response: {
        operation: { airConOperationMode: 'POWER_ON' },
        airConJobMode: { currentJobMode: 'COOL' },
        temperature: { targetTemperatureC: 22 },
        airFlow: { windStrength: 'AUTO' },
      },
    }))
    const cmd = buildTurnOnState({ mode: 'cool', tempC: 22, fan: 'auto' })
    const out = await setDeviceState('ac-1', cmd, CTX)
    expect(out).toMatchObject({ on: true, mode: 'cool', target_temp_c: 22, fan: 'auto' })

    const [, init] = global.fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(cmd)
  })

  it('returns null when LG returns an empty success envelope', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ messageId: 'm' }))
    expect(await setDeviceState('ac-1', { x: 1 }, CTX)).toBeNull()
  })
})

describe('turnOff', () => {
  it('sends only the operation block (POWER_OFF) — other resources omitted', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      response: { operation: { airConOperationMode: 'POWER_OFF' } },
    }))
    const out = await turnOff('ac-1', CTX)
    expect(out.on).toBe(false)

    const [, init] = global.fetch.mock.calls[0]
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toEqual({ operation: { airConOperationMode: 'POWER_OFF' } })
    expect(body.airConJobMode).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })
})

// ----------------------------------------------------------------
// Error handling — surfaces LG's status, code, message
// ----------------------------------------------------------------

describe('error handling', () => {
  it('throws ThinqError with status + LG code + message on non-2xx', async () => {
    global.fetch = vi.fn(async () => jsonResponse(
      { error: { code: '1209', message: 'Device offline' } },
      { status: 400 }
    ))
    await expect(getDeviceState('ac-1', CTX)).rejects.toMatchObject({
      name: 'ThinqError',
      status: 400,
      code: '1209',
      message: 'Device offline',
    })
  })

  it('throws ThinqError on non-2xx with non-JSON body', async () => {
    global.fetch = vi.fn(async () => textResponse('Internal Server Error', { status: 500 }))
    await expect(getDeviceState('ac-1', CTX)).rejects.toMatchObject({
      name: 'ThinqError',
      status: 500,
    })
  })

  it('throws ThinqError when LG returns 200 with an inline error block', async () => {
    // Documented behaviour — LG sometimes returns HTTP 200 with a
    // non-null error object inside the envelope. Treat it the same
    // as a 4xx.
    global.fetch = vi.fn(async () => jsonResponse({
      error: { code: '1300', message: 'Rate limited' },
    }))
    await expect(getDeviceState('ac-1', CTX)).rejects.toMatchObject({
      name: 'ThinqError',
      code: '1300',
      message: 'Rate limited',
    })
  })

  it('wraps fetch network errors as ThinqError with status: 0', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    const err = await getDeviceState('ac-1', CTX).catch((e) => e)
    expect(err).toBeInstanceOf(ThinqError)
    expect(err.status).toBe(0)
    expect(err.message).toMatch(/network error/i)
    expect(err.message).toMatch(/ECONNRESET/)
  })
})
