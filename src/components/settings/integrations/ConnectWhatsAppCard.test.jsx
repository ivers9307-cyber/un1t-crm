// @vitest-environment jsdom
//
// ESV5.1 — the Embedded Signup launch is v5. Business-app onboarding
// (coexistence) is on by default there; the plain Connect button opts out.
// v5's session info names the WABA `messaging_account_ids` and flags a
// Business-app number with `is_on_biz_app`; what the person did in the
// dialog decides the mode sent to the route.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

import { ConnectWhatsAppCard, launchExtras, foldSessionInfo } from './ConnectWhatsAppCard.jsx'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio' }
const OPT_OUT = { version: 'v5', features: [{ name: 'whatsapp_business_app_onboarding', enabled: false }] }

function postFromFacebook(payload) {
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://www.facebook.com',
    data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', ...payload }),
  }))
}

// `onLogin(cb)` plays the dialog: post session info, then answer the callback.
function setup(onLogin = (cb) => cb({})) {
  const posts = []
  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ success: true, data: { label: 'Stillorgan' } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { configured: true, app_id: 'app1', config_id: 'cfg1' } }) }
  })
  const login = vi.fn(onLogin)
  window.FB = { login, init: vi.fn() }
  render(<ConnectWhatsAppCard organizationId="org1" locations={[LOC]} canEdit />)
  return { login, posts }
}

async function press(name) {
  const btn = await screen.findByRole('button', { name })
  await waitFor(() => expect(btn.disabled).toBe(false))
  await act(async () => { fireEvent.click(btn) })
}

afterEach(() => { cleanup(); delete window.FB; vi.restoreAllMocks() })

describe('launchExtras', () => {
  it('coexistence is the v5 default (Business-app onboarding on)', () => {
    expect(launchExtras('coexistence')).toEqual({ version: 'v5' })
  })
  it('Cloud API opts out of Business-app onboarding', () => {
    expect(launchExtras('cloud_api')).toEqual(OPT_OUT)
  })
})

describe('foldSessionInfo', () => {
  it('reads the v5 messaging_account_ids and is_on_biz_app', () => {
    expect(foldSessionInfo({}, { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { messaging_account_ids: ['w1'], phone_number_id: 'p1', is_on_biz_app: true } }))
      .toEqual({ waba_id: 'w1', phone_number_id: 'p1', on_biz_app: true })
  })
  it('still reads a v3-shaped waba_id, and a plain FINISH is not the Business app', () => {
    expect(foldSessionInfo({}, { event: 'FINISH', data: { waba_id: 'w2', phone_number_id: 'p2' } }))
      .toEqual({ waba_id: 'w2', phone_number_id: 'p2', on_biz_app: false })
  })
  it('the coexistence event alone marks the Business app', () => {
    expect(foldSessionInfo({}, { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'w3' } }).on_biz_app).toBe(true)
  })
})

describe('ConnectWhatsAppCard launch', () => {
  it('Connect existing number launches v5 with Business-app onboarding on', async () => {
    const { login } = setup()
    await press(/connect existing number/i)
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    expect(login.mock.calls[0][1]).toEqual({
      config_id: 'cfg1', response_type: 'code', override_default_response_type: true, extras: { version: 'v5' },
    })
  })

  it('the plain Connect button launches v5 opted out', async () => {
    const { login } = setup()
    await press(/^connect$/i)
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
    expect(login.mock.calls[0][1].extras).toEqual(OPT_OUT)
  })

  it('a v5 Business-app finish posts mode coexistence with the WABA from messaging_account_ids', async () => {
    const { posts } = setup((cb) => {
      postFromFacebook({ event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { messaging_account_ids: ['waba-9'], phone_number_id: 'pn-9', is_on_biz_app: true } })
      cb({ authResponse: { code: 'code-1' } })
    })
    await press(/connect existing number/i)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ mode: 'coexistence', code: 'code-1', waba_id: 'waba-9', phone_number_id: 'pn-9', home_location_id: LOC.id })
  })

  it('choosing a new number from Connect existing number posts mode cloud_api', async () => {
    const { posts } = setup((cb) => {
      postFromFacebook({ event: 'FINISH', data: { messaging_account_ids: ['waba-7'], phone_number_id: 'pn-7', is_on_biz_app: false } })
      cb({ authResponse: { code: 'code-2' } })
    })
    await press(/connect existing number/i)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ mode: 'cloud_api', waba_id: 'waba-7', phone_number_id: 'pn-7' })
  })
})
