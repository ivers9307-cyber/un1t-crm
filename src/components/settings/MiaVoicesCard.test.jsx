// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import MiaVoicesCard from './MiaVoicesCard'

const DATA = {
  voices: { lead: { voice_id: 'v1', name: 'Aoife' } },
  ai_notice: null, buttons_line: null,
  available: [{ voice_id: 'v1', name: 'Aoife', category: 'premade', labels: {} }, { voice_id: 'v2', name: 'Brian', category: 'premade', labels: {} }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (!init || init.method === undefined) return { ok: true, json: async () => ({ success: true, data: DATA }) }
    return { ok: true, json: async () => ({ success: true }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Mia\'s voices card', () => {
  it('one picker per kind, each with a play button', async () => {
    render(<MiaVoicesCard canEdit />)
    for (const label of ['Leads and trials', 'Bookings', 'Member questions', 'Hand-off message', 'Default']) {
      expect(await screen.findByLabelText(label)).toBeTruthy()
    }
    expect(screen.getByLabelText('Leads and trials').value).toBe('v1')
    expect(screen.getAllByRole('button', { name: /Play sample/ })).toHaveLength(5)
  })
  it('saves the chosen voices with their names', async () => {
    render(<MiaVoicesCard canEdit />)
    fireEvent.change(await screen.findByLabelText('Bookings'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save voices' }))
    await waitFor(() => expect(fetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true))
    const body = JSON.parse(fetch.mock.calls.find(([, i]) => i?.method === 'PUT')[1].body)
    expect(body.voices.booking).toEqual({ voice_id: 'v2', name: 'Brian' })
    expect(body.voices.lead).toEqual({ voice_id: 'v1', name: 'Aoife' })
    expect(body.voices.member).toBeNull()
  })
  it('read-only without edit rights', async () => {
    render(<MiaVoicesCard canEdit={false} />)
    expect((await screen.findByLabelText('Bookings')).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save voices' })).toBeNull()
  })
})

describe('Check voice setup', () => {
  it('runs the check and shows key, model and audio results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/check')) return { ok: true, json: async () => ({ success: true, data: {
        key: true, voices: { ok: true, count: 2, tested: 'Aoife' }, inUse: 'eleven_v4_turbo', ready: false,
        models: [{ model: 'eleven_v4_turbo', accepted: false, status: 422, ogg: null }, { model: 'eleven_flash_v2_5', accepted: true, status: null, ogg: true }],
      } }) }
      return { ok: true, json: async () => ({ success: true, data: DATA }) }
    }))
    render(<MiaVoicesCard canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check voice setup' }))
    expect(await screen.findByText('Key: found')).toBeTruthy()
    expect(screen.getByText('eleven_v4_turbo: refused (HTTP 422)')).toBeTruthy()
    expect(screen.getByText('eleven_flash_v2_5: accepted · WhatsApp voice-note format (Ogg)')).toBeTruthy()
    expect(screen.getByText(/Not ready/)).toBeTruthy()
  })
  it('no button without edit rights', async () => {
    render(<MiaVoicesCard canEdit={false} />)
    await screen.findByLabelText('Bookings')
    expect(screen.queryByRole('button', { name: 'Check voice setup' })).toBeNull()
  })
})
