import { describe, it, expect, afterEach, vi } from 'vitest'
import { setUnsaved, hasUnsaved, confirmLeave } from './unsaved-guard.js'

afterEach(() => { setUnsaved(false); vi.unstubAllGlobals() })

const stubWindow = (answer) => {
  const confirm = vi.fn(() => answer)
  vi.stubGlobal('window', { confirm })
  return confirm
}

describe('unsaved-guard', () => {
  it('confirmLeave is true and never prompts when nothing is unsaved', () => {
    const confirm = stubWindow(false)
    expect(confirmLeave()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('keeps the flag on yes (the page may stay); the form clears it on unmount', () => {
    const confirm = stubWindow(true)
    setUnsaved(true)
    expect(hasUnsaved()).toBe(true)
    expect(confirmLeave()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?')
    expect(hasUnsaved()).toBe(true)
    expect(confirmLeave()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('keeps the flag when the host says no', () => {
    stubWindow(false)
    setUnsaved(true)
    expect(confirmLeave()).toBe(false)
    expect(hasUnsaved()).toBe(true)
  })
  it('returns true without a window (server)', () => {
    vi.stubGlobal('window', undefined)
    setUnsaved(true)
    expect(confirmLeave()).toBe(true)
  })
})
