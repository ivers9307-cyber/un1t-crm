// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import EventHoldCard from './EventHoldCard'

const LOC = 'a0000000-0000-0000-0000-000000000001'

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EventHoldCard', () => {
  it('shows the stored minutes, or the default when the studio has none', () => {
    render(<EventHoldCard locationId={LOC} locationName="UN1T Hatch Street" initialConfig={{ hold_minutes: 180 }} />)
    expect(screen.getByLabelText('Keep the studio on for (minutes)').value).toBe('180')
    cleanup()
    render(<EventHoldCard locationId={LOC} initialConfig={null} />)
    expect(screen.getByLabelText('Keep the studio on for (minutes)').value).toBe('120')
  })

  it('saves the number for this studio through the automations route', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventHoldCard locationId={LOC} initialConfig={null} />)
    fireEvent.change(screen.getByLabelText('Keep the studio on for (minutes)'), { target: { value: '180' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/automations/event_hold')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ location_id: LOC, enabled: true, config: { hold_minutes: 180 } })
    await screen.findByText('Saved ✓')
    expect(refresh).toHaveBeenCalled()
  })

  it('refuses an out-of-range value without calling the server', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<EventHoldCard locationId={LOC} initialConfig={null} />)
    fireEvent.change(screen.getByLabelText('Keep the studio on for (minutes)'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('between 15 and 1440')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
