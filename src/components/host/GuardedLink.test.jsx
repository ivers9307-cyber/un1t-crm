// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: React.forwardRef(function Link({ href, children, ...rest }, ref) { return <a ref={ref} href={href} {...rest}>{children}</a> }) }
})
const { default: GuardedLink } = await import('./GuardedLink.jsx')
const { setUnsaved } = await import('@/lib/unsaved-guard')

afterEach(() => { cleanup(); setUnsaved(false); vi.restoreAllMocks() })

// fireEvent returns false when the event was default-prevented.
const click = () => fireEvent.click(screen.getByRole('link', { name: 'Go' }))

describe('GuardedLink', () => {
  it('navigates normally when nothing is unsaved', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<GuardedLink href="#events">Go</GuardedLink>)
    expect(click()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('is prevented when unsaved and the host answers no', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    render(<GuardedLink href="#events">Go</GuardedLink>)
    expect(click()).toBe(false)
  })
  it('goes through when the host answers yes', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    setUnsaved(true)
    render(<GuardedLink href="#events">Go</GuardedLink>)
    expect(click()).toBe(true)
  })
  it("still runs the caller's onClick when the navigation is allowed", () => {
    const onClick = vi.fn()
    render(<GuardedLink href="#events" onClick={onClick}>Go</GuardedLink>)
    click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it("does not run the caller's onClick when the host stays", () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    const onClick = vi.fn()
    render(<GuardedLink href="#events" onClick={onClick}>Go</GuardedLink>)
    click()
    expect(onClick).not.toHaveBeenCalled()
  })
  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['a non-primary button', { button: 1 }],
  ])('does not prompt on a %s click, which will not leave the page', (_n, init) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    render(<GuardedLink href="#events">Go</GuardedLink>)
    expect(fireEvent.click(screen.getByRole('link', { name: 'Go' }), init)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('does not prompt for a link that opens a new tab', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    render(<GuardedLink href="#events" target="_blank">Go</GuardedLink>)
    expect(click()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('passes a ref through to the anchor', () => {
    const ref = { current: null }
    render(<GuardedLink href="#events" ref={ref}>Go</GuardedLink>)
    expect(ref.current?.tagName).toBe('A')
  })
})
