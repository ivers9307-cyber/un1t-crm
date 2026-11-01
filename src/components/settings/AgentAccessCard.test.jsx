// @vitest-environment jsdom
//
// MCP.1 Task 10 — the Agent access card on the Integrations hub: the
// organisation's MCP switch, the connector URL with a copy button, the
// "how to connect" paragraph and the 30-day usage line.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import AgentAccessCard from './AgentAccessCard'

const ORG = { id: 'org-1', name: 'UN1T Group' }
const URL_ = 'https://crm.example.test/api/mcp'
const MCP = { enabled: false, connectorUrl: URL_, people30d: 3 }

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { mcp_enabled: true } }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AgentAccessCard', () => {
  it('renders the URL, the connect paragraph and the usage line', () => {
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage />)
    expect(screen.getByText(URL_)).toBeTruthy()
    expect(screen.getByText(/Settings → Connectors → Add custom connector → paste this URL/)).toBeTruthy()
    expect(screen.getByText(new RegExp(`claude mcp add --transport http repset ${URL_}`))).toBeTruthy()
    expect(screen.getByText('3 people used it in the last 30 days')).toBeTruthy()
  })

  it('says "1 person" for one', () => {
    render(<AgentAccessCard organization={ORG} mcp={{ ...MCP, people30d: 1 }} canManage />)
    expect(screen.getByText('1 person used it in the last 30 days')).toBeTruthy()
  })

  it('renders the URL and toggles via PUT', async () => {
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage />)
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/settings/org-mcp')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ organization_id: 'org-1', enabled: true })
  })

  it('keeps the old state and says so when the save fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'nope' }) })
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage />)
    const sw = screen.getByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'))
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('a viewer who cannot manage sees the state but the switch is disabled', () => {
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage={false} />)
    expect(screen.getByRole('switch').disabled).toBe(true)
  })

  it('copies the URL', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage />)
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(writeText).toHaveBeenCalledWith(URL_)
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy())
  })

  it('an unreadable state shows a note and no switch', () => {
    render(<AgentAccessCard organization={ORG} mcp={null} canManage />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText(/Could not load/)).toBeTruthy()
  })

  it('every button is type=button', () => {
    render(<AgentAccessCard organization={ORG} mcp={MCP} canManage />)
    const buttons = screen.getAllByRole('button').concat(screen.getAllByRole('switch'))
    expect(buttons.length).toBeGreaterThan(1)
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button')
  })
})
