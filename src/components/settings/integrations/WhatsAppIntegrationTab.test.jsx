// @vitest-environment jsdom
//
// CHANNELREAD.1 — a failed numbers read used to render "No numbers
// configured … Add a number below", the Add button and the Embedded Signup
// Connect card over a live number. The server refuses a duplicate
// phone_number_id (409), so this was low severity, but the screen lied.
//
// WAORGNUMBER.1 — numbers are added, edited and removed on the organisation's
// page now (src/components/settings/whatsapp/OrgWhatsAppNumbers.test.jsx holds
// the forms' tests). This tab lists them with the studio's on/off switch and
// default radio (Task 6; StudioWhatsAppNumbers.test.jsx holds the switch tests)
// and links there.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import WhatsAppIntegrationTab from './WhatsAppIntegrationTab.jsx'
import { ORG_NUMBERS_PAGE } from '@/lib/org-whatsapp-numbers-page'

const LOC = { id: 'a0000000-0000-4000-8000-000000000001', name: 'Test Studio', settings: {}, organization_id: 'org-1' }
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

function mockFetch(numbersAnswer) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.endsWith('/whatsapp/numbers')) {
      if (numbersAnswer instanceof Error) throw numbersAnswer
      return numbersAnswer
    }
    if (u.endsWith('/whatsapp/embedded-signup')) return reply(200, { success: true, data: { configured: false } })
    return reply(200, { success: true })
  })
}
const urls = () => global.fetch.mock.calls.map(([u]) => String(u))

afterEach(() => { cleanup(); delete global.fetch })

describe('WhatsAppIntegrationTab — a failed numbers read (CHANNELREAD.1)', () => {
  it('a 500 shows Could not load + Try again, no "No numbers", no Add, no Connect card', async () => {
    mockFetch(reply(500, { success: false, error: 'boom' }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText(/Could not load this location's WhatsApp numbers just now/)).toBeTruthy()
    expect(screen.queryByText(/No numbers configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
    expect(urls().some((u) => u.endsWith('/whatsapp/embedded-signup'))).toBe(false)
  })

  it('a network failure shows the same', async () => {
    mockFetch(new TypeError('Failed to fetch'))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
  })
})

describe('WhatsAppIntegrationTab — Try again (CHANNELREAD.1)', () => {
  it('a retry that fails again stays on the note and says "Still could not load"', async () => {
    mockFetch(reply(500, { success: false, error: 'boom' }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still could not load. Try again in a minute.')).toBeTruthy()
    expect(urls().filter((u) => u.endsWith('/whatsapp/numbers'))).toHaveLength(2)
    expect(screen.queryByText(/No numbers configured/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
  })
})

describe("WhatsAppIntegrationTab — the organisation's numbers at this studio (WAORGNUMBER.1)", () => {
  const NUMBER = {
    id: 'n1', label: 'Front desk', display_phone: '+353 00 000 0000', is_active: true, on: true, is_default: true,
  }

  it('no numbers yet shows the empty state, with no Add button and no Connect card', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [] } }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/No numbers configured/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add WhatsApp number/ })).toBeNull()
    expect(screen.queryByText('Connect with WhatsApp')).toBeNull()
    expect(urls().some((u) => u.endsWith('/whatsapp/embedded-signup'))).toBe(false)
  })

  // WAROLE.1 — the chat openers now need the location's own number (the
  // route answers 409 without one instead of using the global env number),
  // so the empty state says so rather than promising the env fallback.
  it('the empty state says chat openers need a number here', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [] } }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/Chat openers can only be saved once this location has its own number/)).toBeTruthy()
  })

  it('an organisation admin is pointed at the organisation page; anyone else is told who to ask', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [] } }))
    const { rerender } = render(<WhatsAppIntegrationTab location={LOC} canEdit canManageNumbers />)
    const link = await screen.findByRole('link', { name: 'WhatsApp numbers' })
    expect(link.getAttribute('href')).toBe(`${ORG_NUMBERS_PAGE}&org=org-1`)
    rerender(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(screen.queryByRole('link', { name: 'WhatsApp numbers' })).toBeNull()
    expect(screen.getByText(/An organisation admin adds, edits and removes numbers/)).toBeTruthy()
  })

  it('a number is listed with its switch and default radio; an inactive one is marked, and nothing is written on load', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [NUMBER, { ...NUMBER, id: 'n2', label: 'Old', on: false, is_default: false, is_active: false }] } }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit canManageNumbers canSwitch />)
    expect(await screen.findByText('Front desk')).toBeTruthy()
    expect(screen.getByText('Inactive')).toBeTruthy()
    expect(screen.getByLabelText('Switch on Front desk at this studio').checked).toBe(true)
    expect(screen.getByLabelText('Make Front desk the default at this studio').checked).toBe(true)
    expect(screen.getByLabelText('Switch on Old at this studio').checked).toBe(false)
    // A number that is not on cannot be the default.
    expect(screen.getByLabelText('Make Old the default at this studio').disabled).toBe(true)
    expect(screen.queryByTitle('Remove this number')).toBeNull()
    const writes = global.fetch.mock.calls.filter(([, init]) => init && init.method && init.method !== 'GET')
    expect(writes).toEqual([])
  })

  it('without canSwitch the switches and radios are disabled', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [NUMBER] } }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect((await screen.findByLabelText('Switch on Front desk at this studio')).disabled).toBe(true)
    expect(screen.getByLabelText('Make Front desk the default at this studio').disabled).toBe(true)
  })
})

// WAROLE.1 — the two editors whose routes are now master/owner at the
// location follow `canEdit`, which the hub drawer takes from the server's
// `ownsWhatsAppHere` flag (src/lib/integrations-hub-location.js), the same
// rule. Without it: no Save, no Add/Edit/Delete, inputs read-only, and no
// write is ever attempted. (A pin: the cards already honoured canEdit.)
describe('WhatsAppIntegrationTab — chat openers and card sets follow canEdit (WAROLE.1)', () => {
  const SET = {
    id: 'b0000000-0000-4000-8000-000000000001', name: 'Intro',
    cards: [{ image_url: 'https://example.test/a.jpg', title: 'A' }, { image_url: 'https://example.test/b.jpg', title: 'B' }],
  }
  // Both cards hydrate from the location's settings (no GET of their own).
  const withSaved = { ...LOC, settings: { conversational_automation: { enable_welcome: true, prompts: ['Book a class'] }, wa_card_sets: [SET] } }
  const mockAll = () => {
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith('/whatsapp/numbers')) return reply(200, { success: true, data: { numbers: [] } })
      if (u.endsWith('/whatsapp/embedded-signup')) return reply(200, { success: true, data: { configured: false } })
      return reply(200, { success: true })
    })
  }

  it('canEdit=false: openers read-only with no Save; card sets listed with no Add, Edit or Delete', async () => {
    mockAll()
    render(<WhatsAppIntegrationTab location={withSaved} canEdit={false} />)
    expect(await screen.findByText('Intro')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save chat openers/ })).toBeNull()
    expect(screen.getByDisplayValue('Book a class').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Add card set/ })).toBeNull()
    expect(screen.queryByTitle('Edit this card set')).toBeNull()
    expect(screen.queryByTitle('Delete this card set')).toBeNull()
    const writes = global.fetch.mock.calls.filter(([, init]) => init && init.method && init.method !== 'GET')
    expect(writes).toEqual([])
  })

  it('canEdit=true: Save, Add, Edit and Delete are offered (unchanged)', async () => {
    mockAll()
    render(<WhatsAppIntegrationTab location={withSaved} canEdit />)
    expect(await screen.findByText('Intro')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save chat openers/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add card set/ })).toBeTruthy()
    expect(screen.getByTitle('Edit this card set')).toBeTruthy()
    expect(screen.getByTitle('Delete this card set')).toBeTruthy()
  })
})

// WACONFIGFALLBACK.1 — there is no env fallback any more: a studio with no
// active number sends and receives no WhatsApp. The copy used to promise
// "falls back to the global WHATSAPP_* env vars". (The Remove and Deactivate
// confirms moved to the organisation's page with the controls.)
describe('WhatsAppIntegrationTab — no env fallback in the copy (WACONFIGFALLBACK.1)', () => {
  it('the empty state says WhatsApp is off here, never the env vars', async () => {
    mockFetch(reply(200, { success: true, data: { numbers: [] } }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/will not send or receive WhatsApp while it has no active number/)).toBeTruthy()
    expect(screen.queryByText(/WHATSAPP_\*/)).toBeNull()
    expect(screen.queryByText(/falls back/)).toBeNull()
  })
})

// WASTUDIOPICK.1 — the Studio picker card: loads its settings from
// /api/whatsapp/studio-picker, offers the question only where the studio has a
// number, and saves exactly what the route expects. No fake timers: every
// wait is a real findBy/waitFor on the DOM.
describe('WhatsAppIntegrationTab — Studio picker card (WASTUDIOPICK.1)', () => {
  const DEFAULT_Q = 'Thanks for getting in touch. Which studio is this about?'
  const PICKER = (over) => ({
    listed: true, label: 'Hatch Street', keywords: ['hatch', 'st'], enabled: true, question: '',
    has_number: true, default_question: DEFAULT_Q, ...over,
  })
  const mockPicker = (picker, putAnswer = { success: true, data: PICKER() }) => {
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('/whatsapp/studio-picker')) {
        if (init?.method === 'PUT') return reply(putAnswer.success ? 200 : 400, putAnswer)
        return picker instanceof Error ? Promise.reject(picker) : reply(200, { success: true, data: picker })
      }
      if (u.endsWith('/whatsapp/numbers')) return reply(200, { success: true, data: { numbers: [] } })
      if (u.endsWith('/whatsapp/embedded-signup')) return reply(200, { success: true, data: { configured: false } })
      return reply(200, { success: true })
    })
  }
  const putCalls = () => global.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')

  it('loads the studio settings into the fields, with the label placeholder and default question', async () => {
    mockPicker(PICKER())
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    const listed = await screen.findByLabelText('Show this studio in the WhatsApp studio picker')
    expect(listed.checked).toBe(true)
    expect(global.fetch.mock.calls.some(([u]) => String(u) === `/api/whatsapp/studio-picker?location_id=${LOC.id}`)).toBe(true)
    const label = screen.getByDisplayValue('Hatch Street')
    expect(label.getAttribute('maxlength')).toBe('20')
    expect(label.getAttribute('placeholder')).toBe('Test Studio')
    expect(screen.getByDisplayValue('hatch, st')).toBeTruthy()
    expect(screen.getByLabelText('Ask new senders which studio they mean').checked).toBe(true)
    const question = screen.getByPlaceholderText(DEFAULT_Q)
    expect(question.getAttribute('maxlength')).toBe('1024')
  })

  it('says a studio with its own number is only offered on that number (F2)', async () => {
    mockPicker(PICKER())
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    await screen.findByLabelText('Show this studio in the WhatsApp studio picker')
    const hint = screen.getByText('Studios with their own WhatsApp number are only offered on their own number.')
    expect(hint.className).toContain('text-un1t-subtle')
  })

  it('hides the question controls when the studio has no number, and saves without them', async () => {
    mockPicker(PICKER({ has_number: false, enabled: false }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    await screen.findByLabelText('Show this studio in the WhatsApp studio picker')
    expect(screen.queryByLabelText('Ask new senders which studio they mean')).toBeNull()
    expect(screen.queryByPlaceholderText(DEFAULT_Q)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Save studio picker/ }))
    expect(await screen.findByText('Saved ✓')).toBeTruthy()
    expect(JSON.parse(putCalls()[0][1].body)).toEqual({
      location_id: LOC.id, listed: true, label: 'Hatch Street', keywords: ['hatch', 'st'],
    })
  })

  it('saves the edited fields: listed, trimmed label, split keywords, enabled and question', async () => {
    mockPicker(PICKER({ listed: false, label: '', keywords: [], enabled: false }))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByLabelText('Show this studio in the WhatsApp studio picker'))
    fireEvent.change(screen.getByPlaceholderText('Test Studio'), { target: { value: '  Stillorgan  ' } })
    fireEvent.change(screen.getByLabelText(/Keywords that point to this studio/), { target: { value: ' still , , blackrock ' } })
    fireEvent.click(screen.getByLabelText('Ask new senders which studio they mean'))
    fireEvent.change(screen.getByPlaceholderText(DEFAULT_Q), { target: { value: ' Which studio? ' } })
    fireEvent.click(screen.getByRole('button', { name: /Save studio picker/ }))
    expect(await screen.findByText('Saved ✓')).toBeTruthy()
    expect(putCalls()).toHaveLength(1)
    expect(putCalls()[0][0]).toBe('/api/whatsapp/studio-picker')
    expect(JSON.parse(putCalls()[0][1].body)).toEqual({
      location_id: LOC.id, listed: true, label: 'Stillorgan', keywords: ['still', 'blackrock'],
      enabled: true, question: 'Which studio?',
    })
  })

  it('shows the route’s error and no "Saved" when the save is refused', async () => {
    mockPicker(PICKER(), { success: false, error: 'Could not save just now. Try again.' })
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Save studio picker/ }))
    expect(await screen.findByText('Could not save just now. Try again.')).toBeTruthy()
    expect(screen.queryByText('Saved ✓')).toBeNull()
  })

  it('a failed load shows a note instead of defaults, and offers no Save', async () => {
    mockPicker(new TypeError('Failed to fetch'))
    render(<WhatsAppIntegrationTab location={LOC} canEdit />)
    expect(await screen.findByText(/Could not load the studio picker settings just now/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save studio picker/ })).toBeNull()
    expect(screen.queryByLabelText('Show this studio in the WhatsApp studio picker')).toBeNull()
  })

  it('canEdit=false: fields are read-only with no Save and no write', async () => {
    mockPicker(PICKER())
    render(<WhatsAppIntegrationTab location={LOC} canEdit={false} />)
    const listed = await screen.findByLabelText('Show this studio in the WhatsApp studio picker')
    expect(listed.disabled).toBe(true)
    expect(screen.getByDisplayValue('Hatch Street').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Save studio picker/ })).toBeNull()
    expect(putCalls()).toEqual([])
  })
})
