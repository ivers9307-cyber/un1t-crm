// @vitest-environment jsdom
//
// C120 GATES-3 (e) — "Start drip" goes through /send, like "Send now".
// POST /api/whatsapp/broadcasts used to create a send-now drip straight into
// 'sending', so the cron sent it with none of /send's checks (template
// approved, own number, quality, wallet). The create now makes a draft and the
// composer calls /send, which starts the drip (draft→sending) and sends
// nothing itself; a refusal is shown and nothing claims the drip started.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { useEffect } from 'react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/components/AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))
vi.mock('./ContactMultiSelect', () => ({ default: () => <div /> }))
vi.mock('./SendQuietHoursNotice', () => ({ default: () => null }))
vi.mock('./CopyAssist', () => ({ default: () => null }))
// The count is <AudienceCount>'s own concern (its tests); here it reports
// a reachable audience once so Send is enabled.
vi.mock('./AudienceCount', () => ({
  default: function AudienceCount({ onResult }) {
    useEffect(() => { onResult({ count: 10, matched: 10, reachable: 10, error: null }) }, [onResult])
    return null
  },
}))
vi.mock('./useUnlayerEditor', async () => {
  const actual = await vi.importActual('./useUnlayerEditor.js')
  return { ...actual, useUnlayerEditor: () => ({ ref: { current: null }, loaded: true, dirty: false, exportHtml: async () => ({}) }) }
})

import UnifiedSendComposer from './UnifiedSendComposer.jsx'

const TEMPLATES = [{ id: 't1', name: 'promo', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello there' }] }]
let posts = []
let sendAnswer = null

beforeEach(() => {
  posts = []
  sendAnswer = { ok: true, body: { success: true, status: 'sending', mode: 'drip', sent: 0, failed: 0, total: 0 } }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/send')) return { ok: sendAnswer.ok, status: sendAnswer.ok ? 200 : 400, json: async () => sendAnswer.body }
    if (String(url) === '/api/whatsapp/broadcasts') return { ok: true, json: async () => ({ success: true, broadcast: { id: 'wb-1' } }) }
    return { ok: true, json: async () => ({ success: true, segments: [] }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function startDrip() {
  render(<UnifiedSendComposer locationId="loc-1" channels={['whatsapp']} templates={TEMPLATES} />)
  fireEvent.change(screen.getByDisplayValue('Choose a template…'), { target: { value: 't1' } })
  fireEvent.click(screen.getByRole('button', { name: /^Drip$/ }))
  const start = await waitFor(() => {
    const b = screen.getAllByRole('button', { name: /start drip/i }).at(-1)
    expect(b.disabled).toBe(false)
    return b
  })
  fireEvent.click(start)
}

describe('UnifiedSendComposer — a send-now drip is started through /send (GATES-3 e)', () => {
  it('creates the broadcast, then calls /send; the drip-started screen follows', async () => {
    await startDrip()
    await waitFor(() => expect(screen.getByText('Drip started')).toBeTruthy())
    const writes = posts.filter((p) => p.url.startsWith('/api/whatsapp/broadcasts'))
    expect(writes.map((p) => p.url)).toEqual(['/api/whatsapp/broadcasts', '/api/whatsapp/broadcasts/wb-1/send'])
    expect(writes[0].body).toMatchObject({ delivery_mode: 'drip', template_id: 't1' })
    expect(writes[0].body.status).toBeUndefined()
  })

  it('a /send refusal is shown and the drip is not reported as started', async () => {
    sendAnswer = { ok: false, body: { success: false, error: 'Template not approved by Meta' } }
    await startDrip()
    await waitFor(() => expect(screen.getByText('Template not approved by Meta')).toBeTruthy())
    expect(screen.queryByText('Drip started')).toBeNull()
  })
})
