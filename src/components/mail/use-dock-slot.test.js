// @vitest-environment jsdom
//
// MAIL-HOOKS.1 — the reader/compose slot machine's own contract, tested at
// the hook seam (MailSurface.compose-dock.test.jsx pins the same behaviour
// through the rendered surface). The claims worth pinning here are the ones
// with a war story behind them: only ⤢/⤡ ever persists (Esc and minimise are
// dismissals), the ONE slot yields in both directions, the compose variant
// freezes at open, and a close from `min` hands the real mode back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useDockSlot } from './use-dock-slot'
import { READER_MODE_KEY, COMPOSE_MODE_KEY } from './mail-display'

beforeEach(() => {
  window.localStorage.clear()
  // jsdom has no matchMedia of its own, so this stub IS md+ — the dock
  // variant. Tests below the breakpoint delete it (isMdUp fails safe to
  // the Modal).
  window.matchMedia = vi.fn(() => ({ matches: true }))
})

afterEach(() => {
  cleanup()
  delete window.matchMedia
  vi.restoreAllMocks()
})

function setup(initialProps = { hasReader: true }) {
  return renderHook((props) => useDockSlot(props), { initialProps })
}

describe('useDockSlot — hydration', () => {
  it('defaults both modes to dock with nothing stored', () => {
    const { result } = setup()
    expect(result.current.readerMode).toBe('dock')
    expect(result.current.composeMode).toBe('dock')
    expect(result.current.composeOpen).toBe(false)
  })

  it('hydrates both stored modes after mount', () => {
    window.localStorage.setItem(READER_MODE_KEY, 'full')
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'full')
    const { result } = setup()
    expect(result.current.readerMode).toBe('full')
    expect(result.current.composeMode).toBe('full')
  })

  it('never hydrates into min — a reload cannot open minimised', () => {
    window.localStorage.setItem(READER_MODE_KEY, 'min')
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'min')
    const { result } = setup()
    expect(result.current.readerMode).toBe('dock')
    expect(result.current.composeMode).toBe('dock')
  })
})

describe('useDockSlot — only ⤢/⤡ persists', () => {
  it('chooseReaderMode writes storage; minimiseReader never does', () => {
    const { result } = setup()
    act(() => { result.current.chooseReaderMode('full') })
    expect(window.localStorage.getItem(READER_MODE_KEY)).toBe('full')
    act(() => { result.current.minimiseReader() })
    expect(result.current.readerMode).toBe('min')
    // min is a transient shape, not a preference — the stored choice stands.
    expect(window.localStorage.getItem(READER_MODE_KEY)).toBe('full')
  })

  it('readerEscStep steps full → dock without persisting, and answers false once the ladder is exhausted', () => {
    const { result } = setup()
    act(() => { result.current.chooseReaderMode('full') })
    let stepped
    act(() => { stepped = result.current.readerEscStep() })
    expect(stepped).toBe(true)
    expect(result.current.readerMode).toBe('dock')
    // Esc is a dismissal — how they like to read stays 'full' for next time.
    expect(window.localStorage.getItem(READER_MODE_KEY)).toBe('full')
    act(() => { stepped = result.current.readerEscStep() })
    expect(stepped).toBe(false) // dock → close is the caller's move
    expect(result.current.readerMode).toBe('dock')
  })

  it('a dirty compose Esc from full steps to dock without persisting', () => {
    const { result } = setup()
    const requestClose = vi.fn()
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.chooseComposeMode('full') })
    act(() => { result.current.handleComposeEscape(true, requestClose) })
    expect(result.current.composeMode).toBe('dock')
    expect(requestClose).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(COMPOSE_MODE_KEY)).toBe('full')
  })
})

describe('useDockSlot — ONE bottom-right slot', () => {
  it('opening compose at md+ sends the reader card to its bar', () => {
    const { result } = setup({ hasReader: true })
    act(() => { result.current.openComposeSlot() })
    expect(result.current.composeOpen).toBe(true)
    expect(result.current.composeVariant).toBe('dock')
    expect(result.current.composeMode).toBe('dock')
    expect(result.current.readerMode).toBe('min')
  })

  it('restoreReader yields: the compose card goes to its bar as the reader comes back', () => {
    const { result } = setup({ hasReader: true })
    act(() => { result.current.openComposeSlot() })   // reader → min, compose card
    act(() => { result.current.restoreReader() })
    expect(result.current.readerMode).toBe('dock')
    expect(result.current.composeMode).toBe('min')    // draft survives in the bar
  })

  it('restoreCompose mirrors the yield: the reader card minimises as compose comes back', () => {
    const { result } = setup({ hasReader: true })
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.restoreReader() })     // reader card, compose bar
    act(() => { result.current.restoreCompose() })
    expect(result.current.composeMode).toBe('dock')
    expect(result.current.readerMode).toBe('min')
  })

  it('claimReaderSlot (a list click) yields compose and un-minimises the reader in one move', () => {
    const { result } = setup({ hasReader: true })
    act(() => { result.current.openComposeSlot() })   // reader min, compose card
    act(() => { result.current.claimReaderSlot() })
    expect(result.current.readerMode).toBe('dock')
    expect(result.current.composeMode).toBe('min')
  })

  it('below md the Modal variant takes no slot — the reader is untouched', () => {
    delete window.matchMedia // jsdom's truth: no matchMedia, no md+
    const { result } = setup({ hasReader: true })
    act(() => { result.current.openComposeSlot() })
    expect(result.current.composeVariant).toBe('modal')
    expect(result.current.readerMode).toBe('dock')
  })

  it('with no reader open there is nothing to yield', () => {
    const { result } = setup({ hasReader: false })
    act(() => { result.current.openComposeSlot() })
    expect(result.current.readerMode).toBe('dock') // not min — nothing was open
  })
})

describe('useDockSlot — the variant freezes at open', () => {
  it('a mid-draft breakpoint change cannot remount the form', () => {
    const { result, rerender } = setup({ hasReader: false })
    act(() => { result.current.openComposeSlot() })
    expect(result.current.composeVariant).toBe('dock')
    // The window narrows mid-draft; isMdUp now answers false — the shell
    // decided AT OPEN must stand for the life of this compose.
    window.matchMedia = vi.fn(() => ({ matches: false }))
    rerender({ hasReader: false })
    expect(result.current.composeVariant).toBe('dock')
  })
})

describe('useDockSlot — min is transient', () => {
  it('unminimiseReader restores the pre-min mode and no-ops on a card', () => {
    const { result } = setup()
    act(() => { result.current.chooseReaderMode('full') })
    act(() => { result.current.minimiseReader() })
    act(() => { result.current.unminimiseReader() })
    expect(result.current.readerMode).toBe('full')
    act(() => { result.current.unminimiseReader() })
    expect(result.current.readerMode).toBe('full')
  })

  it('closeCompose from min hands the NEXT open back to the real mode underneath', () => {
    const { result } = setup()
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.chooseComposeMode('full') })
    act(() => { result.current.minimiseCompose() })
    act(() => { result.current.closeCompose() })
    expect(result.current.composeOpen).toBe(false)
    expect(result.current.composeMode).toBe('full')
  })

  // Audit MINOR — the two seams the mutation table missed. "New email" has no
  // composeOpen guard, so re-opening over a MINIMISED compose is a reachable
  // path: without openComposeSlot's belt-and-braces reset the compose "opens"
  // as a bare title bar.
  it('openComposeSlot over a minimised compose comes back as a card, never a bar', () => {
    const { result } = setup()
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.chooseComposeMode('full') })
    act(() => { result.current.minimiseCompose() })
    act(() => { result.current.openComposeSlot() })
    expect(result.current.composeOpen).toBe(true)
    expect(result.current.composeMode).toBe('full')
  })

  it('closeCompose from a non-min card leaves the mode untouched', () => {
    const { result } = setup()
    act(() => { result.current.openComposeSlot() })
    // Park 'dock' in the restore ref, then sit on 'full': an unconditional
    // reset would snap to the ref's 'dock'; the real conditional must not.
    act(() => { result.current.minimiseCompose() })
    act(() => { result.current.restoreCompose() })
    act(() => { result.current.chooseComposeMode('full') })
    act(() => { result.current.closeCompose() })
    expect(result.current.composeOpen).toBe(false)
    expect(result.current.composeMode).toBe('full')
  })
})

describe('useDockSlot — the dirty-aware compose Esc ladder', () => {
  it('dirty: full → dock → min, and the bar is the floor', () => {
    const { result } = setup()
    const requestClose = vi.fn()
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.chooseComposeMode('full') })
    act(() => { result.current.handleComposeEscape(true, requestClose) })
    expect(result.current.composeMode).toBe('dock')
    act(() => { result.current.handleComposeEscape(true, requestClose) })
    expect(result.current.composeMode).toBe('min')
    act(() => { result.current.handleComposeEscape(true, requestClose) })
    expect(result.current.composeMode).toBe('min') // the floor — never discards
    expect(requestClose).not.toHaveBeenCalled()
  })

  it('pristine: Esc closes via requestClose from any shape, mode untouched', () => {
    const { result } = setup()
    const requestClose = vi.fn()
    act(() => { result.current.openComposeSlot() })
    act(() => { result.current.handleComposeEscape(false, requestClose) })
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(result.current.composeMode).toBe('dock')
  })
})
