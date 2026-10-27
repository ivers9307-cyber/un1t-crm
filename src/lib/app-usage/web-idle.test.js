import { describe, it, expect, vi } from 'vitest'
import { createIdleWatch, WEB_IDLE_MS } from './web-idle.js'

function watch() {
  const onIdle = vi.fn()
  const onActive = vi.fn()
  return { w: createIdleWatch({ onIdle, onActive }), onIdle, onActive }
}

describe('createIdleWatch', () => {
  it('idles 5 min after the last input, timed at that input', () => {
    const { w, onIdle } = watch()
    w.input(0)
    w.tick(WEB_IDLE_MS)
    expect(onIdle).not.toHaveBeenCalled()
    w.tick(WEB_IDLE_MS + 1)
    expect(onIdle).toHaveBeenCalledWith(0)
    w.tick(WEB_IDLE_MS + 60_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('becomes active again on the next input', () => {
    const { w, onActive } = watch()
    w.input(0)
    w.tick(400_000)
    w.input(400_000)
    expect(onActive).toHaveBeenCalledWith(400_000)
  })

  it('an input while active is not a new activation', () => {
    const { w, onActive } = watch()
    w.input(0)
    w.input(1000)
    expect(onActive).not.toHaveBeenCalled()
  })

  it('a hidden tab ends the session at once, and showing it resumes', () => {
    const { w, onIdle, onActive } = watch()
    w.input(0)
    w.hidden(10_000)
    expect(onIdle).toHaveBeenCalledWith(10_000)
    w.visible(20_000)
    expect(onActive).toHaveBeenCalledWith(20_000)
  })

  it('a tick while hidden does nothing', () => {
    const { w, onIdle } = watch()
    w.hidden(0)
    w.tick(WEB_IDLE_MS * 3)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('input while hidden does not resume', () => {
    const { w, onActive } = watch()
    w.hidden(0)
    w.input(1000)
    expect(onActive).not.toHaveBeenCalled()
  })
})
