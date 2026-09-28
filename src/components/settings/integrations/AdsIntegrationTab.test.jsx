// @vitest-environment jsdom
//
// CHANNELREAD.1 — the Ads tab (hub drawer + Ads tab) used to show a red
// banner AND every provider form with row=null (Account ID blank, Active
// off), so a Save after a failed read could deactivate the live account.
// A failed read now shows Could not load + Try again and no form at all.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import AdsIntegrationTab from './AdsIntegrationTab.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }
const META = {
  id: 'ad-1', provider: 'meta', external_account_id: 'act_1234567890', is_active: true,
  access_token: '••••••••1234', has_access_token: true, last_synced_at: null, last_sync_error: null,
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

function mockGets(...answers) {
  let i = 0
  global.fetch = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  })
}

afterEach(() => { cleanup(); delete global.fetch })

function expectNoForms() {
  expect(screen.queryByText('Daily report recipients')).toBeNull()
  expect(screen.queryByText('Account ID')).toBeNull()
  expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Test connection/ })).toBeNull()
}

describe('AdsIntegrationTab — a failed read (CHANNELREAD.1)', () => {
  it('a 500 shows Could not load + Try again and no provider or recipients form', async () => {
    mockGets(reply(500, { success: false, error: 'Could not load the ad accounts just now.' }))
    render(<AdsIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText(/Could not load this location's ad accounts just now/)).toBeTruthy()
    expectNoForms()
  })

  it('a network failure shows the same', async () => {
    mockGets(new TypeError('Failed to fetch'))
    render(<AdsIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expectNoForms()
  })

  it('Try again that succeeds shows the live account', async () => {
    mockGets(reply(500, { success: false }), reply(200, { success: true, data: [META], report_recipients: [] }))
    render(<AdsIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByDisplayValue('act_1234567890')).toBeTruthy()
  })
})

describe('AdsIntegrationTab — real answers are unchanged (pins)', () => {
  it('a live account prefills its form', async () => {
    mockGets(reply(200, { success: true, data: [META], report_recipients: ['ops@example.test'] }))
    render(<AdsIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByDisplayValue('act_1234567890')).toBeTruthy()
    expect(screen.getByDisplayValue('ops@example.test')).toBeTruthy()
  })

  it('no account yet shows empty forms (a real "nothing here")', async () => {
    mockGets(reply(200, { success: true, data: [], report_recipients: [] }))
    render(<AdsIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText('Daily report recipients')).toBeTruthy()
    expect(screen.getAllByText('Account ID').length).toBeGreaterThan(0)
  })
})
