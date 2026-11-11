// @vitest-environment jsdom
// Copy-link button: writes the URL to the clipboard and says "Copied" for a moment.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import CopyLinkButton from './CopyLinkButton.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('CopyLinkButton', () => {
  it('writes the url to the clipboard and shows Copied', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<CopyLinkButton url="https://crm.test/event/x" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith('https://crm.test/event/x')
  })

  it('stays on Copy link when the clipboard is unavailable', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<CopyLinkButton url="https://crm.test/event/x" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })

  it('clears its reset timer on unmount', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    const { unmount } = render(<CopyLinkButton url="u" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    clear.mockClear()
    unmount()
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
