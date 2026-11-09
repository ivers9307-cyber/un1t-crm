// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import HostThemeToggle from './HostThemeToggle.jsx'

function mount(initial) {
  return render(<div data-host-theme={initial}><HostThemeToggle initial={initial} /></div>)
}
const light = () => screen.getByRole('button', { name: 'Use the light theme' })
const dark = () => screen.getByRole('button', { name: 'Use the dark theme' })

beforeEach(() => { document.cookie = 'host_theme=; Path=/; Max-Age=0' })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostThemeToggle', () => {
  it('marks the initial theme as pressed', () => {
    mount('light')
    expect(light().getAttribute('aria-pressed')).toBe('true')
    expect(dark().getAttribute('aria-pressed')).toBe('false')
    cleanup()
    mount('dark')
    expect(dark().getAttribute('aria-pressed')).toBe('true')
    expect(light().getAttribute('aria-pressed')).toBe('false')
  })
  it('resolves system from the device and marks that one', () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: q === '(prefers-color-scheme: light)' }))
    mount('system')
    expect(light().getAttribute('aria-pressed')).toBe('true')
    expect(dark().getAttribute('aria-pressed')).toBe('false')
  })
  it('resolves system to dark when the device says dark or matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    mount('system')
    expect(dark().getAttribute('aria-pressed')).toBe('true')
    cleanup()
    vi.stubGlobal('matchMedia', undefined)
    mount('system')
    expect(dark().getAttribute('aria-pressed')).toBe('true')
  })
  it('a click sets the attribute on the wrapper, writes the cookie and moves aria-pressed', () => {
    const { container } = mount('dark')
    fireEvent.click(light())
    expect(container.querySelector('[data-host-theme]').getAttribute('data-host-theme')).toBe('light')
    expect(document.cookie).toContain('host_theme=light')
    expect(light().getAttribute('aria-pressed')).toBe('true')
    expect(dark().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(dark())
    expect(container.querySelector('[data-host-theme]').getAttribute('data-host-theme')).toBe('dark')
    expect(document.cookie).toContain('host_theme=dark')
  })
  it('buttons are type=button so a surrounding form never submits', () => {
    mount('dark')
    expect(light().getAttribute('type')).toBe('button')
    expect(dark().getAttribute('type')).toBe('button')
  })
})
