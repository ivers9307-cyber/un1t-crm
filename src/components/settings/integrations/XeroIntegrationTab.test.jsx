// @vitest-environment jsdom
// CHANNELREAD.1 — the Xero tab never offers Connect Xero over a read that failed.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import XeroIntegrationTab from './XeroIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }
afterEach(() => cleanup())

describe('XeroIntegrationTab', () => {
  it('readFailed → Could not load + a Try again link back to the tab; no Connect, no "Not connected"', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} readFailed />)
    expect(screen.getByText(/Could not load this location's Xero connection just now/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(`/settings/locations/${LOC.id}?tab=xero`)
    expect(screen.queryByText(/Connect Xero/)).toBeNull()
    expect(screen.queryByText('Not connected.')).toBeNull()
  })

  it('pin: a real "no connection" still offers Connect Xero', () => {
    render(<XeroIntegrationTab location={LOC} connection={null} />)
    expect(screen.getByText(/Connect Xero/)).toBeTruthy()
  })
})
