// @vitest-environment jsdom
//
// COMMSFIX.D.2b/D.2c — the composer must not be able to queue a blank email.
// canSend gated email on subject + audience count ONLY, never on the designer
// having loaded, and send() posted whatever exportHtml handed back — which was
// '' on every failure path. Audit 2026-08-09 composer-ux, CONFIRMED high.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/components/AudienceBuilder', () => ({
  default: () => <div data-testid="audience-builder" />,
}))
vi.mock('./ContactMultiSelect', () => ({ default: () => <div /> }))

// Controlled Unlayer stand-in — the real hook is covered by
// useUnlayerEditor.test.jsx; here we drive its two outcomes.
let unlayerLoaded = true
let unlayerDirty = false
let exportImpl = async () => ({ html: '<html><body>Hi</body></html>', design: { rows: [] } })
vi.mock('./useUnlayerEditor', async () => {
  const actual = await vi.importActual('./useUnlayerEditor.js')
  return {
    ...actual,
    useUnlayerEditor: () => ({
      ref: { current: null },
      loaded: unlayerLoaded,
      dirty: unlayerDirty,
      exportHtml: (...args) => exportImpl(...args),
    }),
  }
})

import UnifiedSendComposer from './UnifiedSendComposer.jsx'
import { EXPORT_FAILED } from './useUnlayerEditor.js'

let posts = []

function mockFetch() {
  return vi.fn(async (url, init) => {
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).includes('audience-count')) {
      return { ok: true, json: async () => ({ success: true, count: 120 }) }
    }
    return { ok: true, json: async () => ({ success: true, id: 'camp-9' }) }
  })
}

beforeEach(() => {
  posts = []
  unlayerLoaded = true
  unlayerDirty = false
  exportImpl = async () => ({ html: '<html><body>Hi</body></html>', design: { rows: [] } })
  vi.stubGlobal('fetch', mockFetch())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderComposer() {
  return render(<UnifiedSendComposer locationId="loc-1" channels={['email']} templates={[]} />)
}

// The "When" section also has a "Send now" pill; the submit Button is the
// last one on the page.
const sendButton = () => screen.getAllByRole('button', { name: /send now/i }).at(-1)

async function readyWithSubject() {
  renderComposer()
  fireEvent.change(screen.getByPlaceholderText('Email subject'), { target: { value: 'Last chance' } })
  await waitFor(() => expect(posts.some(p => String(p.url).includes('audience-count'))).toBe(true))
  await waitFor(() => expect(screen.getByText(/contacts? match this filter/)).toBeTruthy())
}

describe('UnifiedSendComposer — Send is gated on the designer being ready', () => {
  it('disables Send while the email designer is still loading', async () => {
    unlayerLoaded = false
    await readyWithSubject()
    expect(sendButton().disabled).toBe(true)
  })

  it('enables Send once the designer has loaded', async () => {
    await readyWithSubject()
    expect(sendButton().disabled).toBe(false)
  })
})

describe('UnifiedSendComposer — a failed export never posts', () => {
  it('shows the export error and posts nothing to email-draft', async () => {
    exportImpl = async () => { throw new Error(EXPORT_FAILED) }
    await readyWithSubject()
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText(EXPORT_FAILED)).toBeTruthy())
    expect(posts.filter(p => String(p.url).includes('email-draft'))).toHaveLength(0)
    // No success screen — the operator stays on the composer with their work.
    expect(screen.queryByText(/^Queued$/)).toBeNull()
  })

  it('posts the exported html on a successful export', async () => {
    await readyWithSubject()
    fireEvent.click(sendButton())

    await waitFor(() => {
      const draft = posts.find(p => String(p.url).includes('email-draft'))
      expect(draft).toBeTruthy()
      expect(draft.body.html_content).toContain('Hi')
      expect(draft.body.action).toBe('send')
    })
  })

  it('does not create an empty draft when Open the full editor hits a failed export', async () => {

    exportImpl = async () => { throw new Error(EXPORT_FAILED) }
    await readyWithSubject()
    fireEvent.click(screen.getByRole('button', { name: /open the full editor/i }))

    await waitFor(() => expect(screen.getByText(EXPORT_FAILED)).toBeTruthy())
    expect(posts.filter(p => String(p.url).includes('email-draft'))).toHaveLength(0)
  })
})

// COMMSFIX.D.4a — the Unlayer mount div only renders while channel === 'email',
// and the hook deliberately re-inits fresh on re-mount. Clicking the WhatsApp
// pill to check a template name and clicking back therefore wiped a
// half-finished design with no warning, no stash and no beforeunload guard.
// Audit 2026-08-09 composer-ux.
describe('UnifiedSendComposer — switching away from email guards the design', () => {
  function renderMulti() {
    return render(<UnifiedSendComposer locationId="loc-1" channels={['email', 'whatsapp']} templates={[]} />)
  }
  const whatsappPill = () => screen.getByRole('button', { name: /^WhatsApp$/ })
  const emailPanel = () => screen.queryByPlaceholderText('Email subject')

  it('switches silently when the design is untouched', () => {
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    renderMulti()
    fireEvent.click(whatsappPill())
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(emailPanel()).toBeNull()
  })

  it('asks before discarding a design that has been edited', () => {
    unlayerDirty = true
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    renderMulti()
    fireEvent.click(whatsappPill())
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toMatch(/design/i)
    expect(emailPanel()).toBeNull()
  })

  it('stays on email — design intact — when the operator declines', () => {
    unlayerDirty = true
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderMulti()
    fireEvent.click(whatsappPill())
    expect(emailPanel()).toBeTruthy()
  })
})

// ── COPYCLAIM.1 — no unevidenced performance claims in composer copy ──
//
// The resend panel's helper text used to read "A fresh subject usually lifts
// second-send opens." Nothing in this estate supports that: nine campaigns,
// with open rates that track content type rather than wording. It is the
// exact claim src/lib/copy-assist.js refuses to make ("It does not predict or
// rank what will perform ... Claiming otherwise would be fabrication") — so
// the composer should not make it in a label either.
//
// A source scan rather than a render, because the offending strings sit in
// panels that need several pieces of state to appear, and the point is that
// none of the composer's copy should carry a claim like this.

describe('composer helper copy makes no unevidenced performance claim', () => {
  const CLAIMS = [
    /\b(usually|typically|generally|on average)\b[^.]{0,60}\b(lift|lifts|boost|boosts|increase|increases|improve|improves)\b/i,
    /\b(lifts|boosts|increases|improves)\b[^.]{0,40}\b(opens|open rates?|clicks|click rates?|replies|conversions?)\b/i,
    /\b(higher|better|more)\b[^.]{0,30}\b(open rates?|click rates?)\b[^.]{0,30}\b(when|if)\b/i,
  ]

  it.each([
    'UnifiedSendComposer.jsx',
    'CopyAssist.jsx',
  ])('%s', async (file) => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(path.join(process.cwd(), 'src/components/communications', file), 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => CLAIMS.some((re) => re.test(line)))
      .map(([n, line]) => `${n}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })
})
