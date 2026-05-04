// Tests for verifyWebhookSignature in src/lib/revolut.js, focused
// on the multi-secret behaviour added in mig 084 / Option B.

import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'

// Set a deterministic env var BEFORE importing the SUT — getConfig()
// reads REVOLUT_API_KEY at import time.
beforeAll(() => {
  process.env.REVOLUT_API_KEY = 'sk_test_dummy'
})

const { verifyWebhookSignature } = await import('./revolut.js')

function sign(body, secret, timestamp) {
  const payload = `v1.${timestamp}.${body}`
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

describe('verifyWebhookSignature — single-secret', () => {
  it('verifies a valid signature using opts.secrets', () => {
    const secret = 'wsk_cars'
    const ts = String(Date.now())
    const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'abc' })
    const sig = `v1=${sign(body, secret, ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: secret })).toBe(true)
  })

  it('rejects when the secret does not match', () => {
    const ts = String(Date.now())
    const body = 'hello'
    const sig = `v1=${sign(body, 'wrong-secret', ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: 'real-secret' })).toBe(false)
  })

  it('rejects when timestamp is too old (> 5min)', () => {
    const secret = 'wsk_cars'
    const ts = String(Date.now() - 6 * 60 * 1000)
    const body = 'old'
    const sig = `v1=${sign(body, secret, ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: secret })).toBe(false)
  })
})

describe('verifyWebhookSignature — multi-secret (Option B)', () => {
  it('verifies against the FIRST secret when both provided', () => {
    const raceSecret = 'wsk_race'
    const carsSecret = 'wsk_cars'
    const ts = String(Date.now())
    const body = '{}'
    const sig = `v1=${sign(body, raceSecret, ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: [raceSecret, carsSecret] })).toBe(true)
  })

  it('falls back to the SECOND secret when the first does not match', () => {
    const raceSecret = 'wsk_race'
    const carsSecret = 'wsk_cars'
    const ts = String(Date.now())
    const body = '{}'
    // Webhook was signed with the SHARED (cars) secret — pre-split case.
    const sig = `v1=${sign(body, carsSecret, ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: [raceSecret, carsSecret] })).toBe(true)
  })

  it('rejects when neither secret matches', () => {
    const ts = String(Date.now())
    const body = '{}'
    const sig = `v1=${sign(body, 'unknown', ts)}`
    expect(verifyWebhookSignature(body, sig, ts, { secrets: ['wsk_race', 'wsk_cars'] })).toBe(false)
  })

  it('skips empty / undefined entries in the secrets list', () => {
    const realSecret = 'wsk_real'
    const ts = String(Date.now())
    const body = '{}'
    const sig = `v1=${sign(body, realSecret, ts)}`
    // The race route's [process.env.NEW, process.env.OLD].filter(Boolean)
    // is what produces this shape when NEW isn't set yet.
    expect(verifyWebhookSignature(body, sig, ts, { secrets: [undefined, realSecret] })).toBe(true)
  })
})
