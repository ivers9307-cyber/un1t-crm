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
  it('prompts once when unsaved, and clears the flag on yes', () => {
    const confirm = stubWindow(true)
    setUnsaved(true)
    expect(hasUnsaved()).toBe(true)
    expect(confirmLeave()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?')
    expect(hasUnsaved()).toBe(false)
    expect(confirmLeave()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
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
