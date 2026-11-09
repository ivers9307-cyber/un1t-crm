// @vitest-environment jsdom
// HOSTPORTAL.2 — Take off sale / Delete ask about unsaved edits too, clear the
// flag on success, and say whether any action exists at all.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const { default: HostEventActions, hasHostEventActions } = await import('./HostEventActions.jsx')
const { setUnsaved, hasUnsaved } = await import('@/lib/unsaved-guard')

afterEach(() => { cleanup(); setUnsaved(false); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ok = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }))

describe('hasHostEventActions', () => {
  it('offers Take off sale for a published event', () => {
    expect(hasHostEventActions({ status: 'published', hasRegistrations: true })).toBe(true)
  })
  it('offers Delete for a non-published event with no registrations', () => {
    expect(hasHostEventActions({ status: 'draft', hasRegistrations: false })).toBe(true)
  })
  it('offers nothing for a non-published event that has registrations', () => {
    expect(hasHostEventActions({ status: 'draft', hasRegistrations: true })).toBe(false)
    expect(hasHostEventActions({ status: 'pending_review', hasRegistrations: true })).toBe(false)
  })
})

describe('HostEventActions', () => {
  it('renders nothing when there is no action to offer', () => {
    const { container } = render(<HostEventActions eventId="e1" status="draft" hasRegistrations />)
    expect(container.firstChild).toBeNull()
  })

  it('Take off sale: declining the unsaved-changes question stops before the sale confirm and any request', () => {
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    render(<HostEventActions eventId="e1" status="published" hasRegistrations />)
    fireEvent.click(screen.getByRole('button', { name: 'Take off sale' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/unsaved/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Take off sale: with nothing unsaved asks only its own confirm, and clears the flag on success', async () => {
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const reload = vi.fn()
    vi.stubGlobal('location', { reload, href: '' })
    render(<HostEventActions eventId="e1" status="published" hasRegistrations />)
    fireEvent.click(screen.getByRole('button', { name: 'Take off sale' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/host/events/e1/unpublish', { method: 'POST' })
  })

  it('Take off sale: unsaved edits are asked about once more and the flag is cleared before the reload', async () => {
    vi.stubGlobal('fetch', ok())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    let flagAtReload = null
    vi.stubGlobal('location', { reload: () => { flagAtReload = hasUnsaved() }, href: '' })
    setUnsaved(true)
    render(<HostEventActions eventId="e1" status="published" hasRegistrations />)
    fireEvent.click(screen.getByRole('button', { name: 'Take off sale' }))
    await waitFor(() => expect(flagAtReload).not.toBeNull())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(flagAtReload).toBe(false)
  })

  it('Delete: declining the unsaved-changes question sends no request', () => {
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    setUnsaved(true)
    render(<HostEventActions eventId="e1" status="draft" hasRegistrations={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Delete: clears the flag before redirecting', async () => {
    vi.stubGlobal('fetch', ok())
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let flagAtRedirect = null
    const loc = { reload: vi.fn() }
    Object.defineProperty(loc, 'href', { set() { flagAtRedirect = hasUnsaved() }, get() { return '' } })
    vi.stubGlobal('location', loc)
    setUnsaved(true)
    render(<HostEventActions eventId="e1" status="draft" hasRegistrations={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))
    await waitFor(() => expect(flagAtRedirect).not.toBeNull())
    expect(flagAtRedirect).toBe(false)
  })

  it('a failed action keeps the unsaved flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'No.' }) })))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    setUnsaved(true)
    render(<HostEventActions eventId="e1" status="draft" hasRegistrations={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))
    expect(await screen.findByText('No.')).toBeTruthy()
    expect(hasUnsaved()).toBe(true)
  })
})
