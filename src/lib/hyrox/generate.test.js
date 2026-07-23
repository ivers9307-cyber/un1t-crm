import { describe, it, expect, vi } from 'vitest'
import { generateArc, expandSession } from './generate'

function fakeFetch(payloadText) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: payloadText }] }),
  }))
}

// Returns a fetchImpl that always responds with a non-ok HTTP status (no body parse).
function fakeFetchStatus(status) {
  return vi.fn(async () => ({ ok: false, status }))
}

// Returns a fetchImpl that yields a different payload text on each successive call
// (last payload repeats if called more times than payloads provided).
function fakeFetchSequence(payloads) {
  let call = 0
  return vi.fn(async () => {
    const text = payloads[Math.min(call, payloads.length - 1)]
    call += 1
    return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) }
  })
}

const goodArc = JSON.stringify({ weeks: 12, dial: 'mixed', plan: [{ week_no: 1, phase: 'base', stimulus: 'base', is_benchmark: false, progression: 'build volume' }] })

const goodSession = JSON.stringify({
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine', is_benchmark: false,
  full_session: { warmup: 'row + drills', main: '4 RFT', cues: ['brace'], why: 'engine block; race energy' },
  board: {
    location_label: 'UN1T STILLORGAN', week_label: 'WEEK 5 / 12', focus: 'ENGINE',
    format: '4 ROUNDS FOR TIME', cap_minutes: 45,
    stations: [{ name: 'Run', performance: '400m', elite: '500m' }],
    target: 'Target sub-32:00',
  },
})

describe('generateArc', () => {
  it('parses and returns a validated arc', async () => {
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: fakeFetch(goodArc), apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(res.data.plan[0].phase).toBe('base')
  })
  it('retries once on invalid JSON then fails cleanly', async () => {
    const f = fakeFetch('not json at all')
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: f, apiKey: 'k' })
    expect(res.ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(2) // one retry
  })
  it('returns {ok:false} on non-ok HTTP responses, retried once', async () => {
    const f = fakeFetchStatus(500)
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: f, apiKey: 'k' })
    expect(res.ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('recovers on the retry when the first attempt is invalid JSON and the second is valid', async () => {
    const f = fakeFetchSequence(['not json at all', goodArc])
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: f, apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(res.data.plan[0].phase).toBe('base')
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('fails without ever calling fetchImpl when the API key is missing', async () => {
    const f = fakeFetch(goodArc)
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: f, apiKey: '' })
    expect(res.ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
  it('uses an injected caller when provided (bypasses fetch)', async () => {
    const calls = []
    const caller = async ({ system, user, maxTokens }) => { calls.push({ system, user, maxTokens }); return { ok: true, text: goodArc } }
    const noFetch = () => { throw new Error('fetch must not be called') }
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { caller, fetchImpl: noFetch, apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('tough, challenging, but doable, and always fun')
  })
})

describe('expandSession', () => {
  it('parses and returns a validated session', async () => {
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'add a round', is_benchmark: false }
    const res = await expandSession(
      { week, slot: 1, dial: 'mixed', locationLabel: 'UN1T STILLORGAN' },
      { fetchImpl: fakeFetch(goodSession), apiKey: 'k' },
    )
    expect(res.ok).toBe(true)
    expect(res.data.focus).toBe('Engine')
    expect(res.data.board.wordmark).toBe('HYROX TRAINING CLUB')
  })
})
