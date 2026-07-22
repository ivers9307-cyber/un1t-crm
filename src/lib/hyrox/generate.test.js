import { describe, it, expect, vi } from 'vitest'
import { generateArc, expandSession } from './generate'

function fakeFetch(payloadText) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: payloadText }] }),
  }))
}

const goodArc = JSON.stringify({ weeks: 12, dial: 'mixed', plan: [{ week_no: 1, phase: 'base', stimulus: 'base', is_benchmark: false, progression: 'build volume' }] })

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
})
