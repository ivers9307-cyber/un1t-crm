// LEAVEPHONE.1 — the submit latch. A double tap on Submit must POST once.
import { describe, it, expect } from 'vitest'
import { createInFlightGuard } from './in-flight-guard'

describe('createInFlightGuard', () => {
  it('begin() is true exactly once until end()', () => {
    const g = createInFlightGuard()
    expect(g.begin()).toBe(true)
    expect(g.begin()).toBe(false)
    expect(g.busy).toBe(true)
    g.end()
    expect(g.busy).toBe(false)
    expect(g.begin()).toBe(true)
  })

  it('run(): a second call while the first is in flight does NOT run its work', async () => {
    const g = createInFlightGuard()
    let calls = 0
    let release
    const first = g.run(() => new Promise((resolve) => { calls++; release = resolve }))
    const second = await g.run(async () => { calls++ })
    expect(second).toBeUndefined()
    expect(calls).toBe(1)
    release('done')
    expect(await first).toBe('done')
    expect(g.busy).toBe(false)
  })

  it('run(): the latch is released when the work throws, synchronously or not', async () => {
    const g = createInFlightGuard()
    await expect(g.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
    expect(g.busy).toBe(false)
    await expect(g.run(async () => { throw new Error('async') })).rejects.toThrow('async')
    expect(g.busy).toBe(false)
  })

  it('two guards are independent', () => {
    const a = createInFlightGuard()
    const b = createInFlightGuard()
    expect(a.begin()).toBe(true)
    expect(b.begin()).toBe(true)
  })
})
