// @vitest-environment jsdom
//
// UN1TCOMP.1 — complimentary un1t.online credits on the Hatch card: the
// button only with the permission, the form's limits and its use-by maths on
// the STUDIO's clock (Europe/Dublin and America/New_York across a DST
// change), the POST, the open-thread message and the "given" list.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
import Un1tCompCredits from './Un1tCompCredits.jsx'
import Un1tClassBookingCard from './Un1tClassBookingCard.jsx'

const LOC = 'loc-hatch'
const DUBLIN = 'Europe/Dublin'
const NEW_YORK = 'America/New_York'
// Wed 28 Oct 2026, midday at the studio.
const NOON = Date.parse('2026-10-28T12:00:00Z')

let calls
let compAnswer
beforeEach(() => {
  calls = []
  compAnswer = { success: true, data: { batch_id: 'batch-9', expires_at: '2026-11-04T12:00:00Z', amount: 1, use_by: '2026-11-04', message: 'Added 1 credit in un1t.online, usable until Wed 4 Nov.', chat_template: null } }
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status })
    if (u === '/api/un1t-online/credits/comp') return json(compAnswer, compAnswer.success ? 200 : 502)
    if (u.startsWith('/api/whatsapp/conversations/')) return json({ success: true })
    return json({ success: false })
  })
})
afterEach(() => cleanup())

const form = (props = {}) => render(
  <Un1tCompCredits contactId="c1" locationId={LOC} studioName="UN1T Hatch Street" zone={DUBLIN} canGrant given={[]}
    canWhatsApp={false} waConversationId={null} onGranted={vi.fn()} nowMs={NOON} {...props} />,
)
const summary = () => screen.getByTestId('comp-summary').textContent

describe('the button', () => {
  it('is hidden without the permission', () => {
    form({ canGrant: false })
    expect(screen.queryByRole('button', { name: /Add complimentary credits/ })).toBeNull()
  })

  it('on the card only when the class list says comp.can_grant', async () => {
    const payload = (canGrant) => ({ classes: [], upcoming: [], credits: { balance: 2, unlimited: false, as_of: null }, zone: DUBLIN, comp: { can_grant: canGrant, given: [] } })
    let canGrant = false
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: payload(canGrant) }), { status: 200 }))
    const mount = () => render(<Un1tClassBookingCard contactId="c1" locationId={LOC} studioName="Hatch Street" waConversationId={null} waWindowOpen={false} />)
    mount()
    expect(await screen.findByText(/Credits: 2/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add complimentary credits/ })).toBeNull()
    cleanup()
    canGrant = true
    mount()
    expect(await screen.findByRole('button', { name: /Add complimentary credits/ })).toBeTruthy()
  })
})

describe('the form', () => {
  it('opens on 1 credit, use by in 1 week, and says so; the button counts the credits', () => {
    form()
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByLabelText('Use by').value).toBe('2026-11-04')
    expect(summary()).toBe('Adds 1 credit in un1t.online, usable until Wed 4 Nov (7 days).')
    fireEvent.click(screen.getByRole('button', { name: 'More credits' }))
    fireEvent.click(screen.getByRole('button', { name: 'More credits' }))
    expect(screen.getByRole('button', { name: 'Add 3 credits' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 month' }))
    expect(summary()).toBe('Adds 3 credits in un1t.online, usable until Sat 28 Nov (31 days).')
    fireEvent.click(screen.getByRole('button', { name: '2 weeks' }))
    expect(summary()).toBe('Adds 3 credits in un1t.online, usable until Wed 11 Nov (14 days).')
  })

  it('the stepper stops at 1 and 10', () => {
    form()
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByRole('button', { name: 'Fewer credits' }).disabled).toBe(true)
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole('button', { name: 'More credits' }))
    expect(screen.getByTestId('comp-amount').textContent).toBe('10')
    expect(screen.getByRole('button', { name: 'More credits' }).disabled).toBe(true)
  })

  it('needs a reason before it can be sent, and refuses an email in the note', () => {
    form()
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByRole('button', { name: 'Add 1 credit' }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'injury' } })
    expect(screen.getByRole('button', { name: 'Add 1 credit' }).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Team note'), { target: { value: 'ask jo@example.com' } })
    expect(screen.getByText('Leave email addresses out of the note.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add 1 credit' }).disabled).toBe(true)
  })

  it('a date outside tomorrow to a year ahead has no summary and cannot be sent', () => {
    form()
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'goodwill' } })
    fireEvent.change(screen.getByLabelText('Use by'), { target: { value: '2026-10-28' } })
    expect(summary()).toBe('Choose a use-by date from tomorrow to a year ahead.')
    expect(screen.getByRole('button', { name: 'Add 1 credit' }).disabled).toBe(true)
  })

  it('the date bounds are on the studio clock: Dublin vs New York the night Dublin falls back', () => {
    const now = Date.parse('2026-10-25T23:30:00Z') // 23:30 GMT in Dublin, 19:30 EDT in New York: both the 25th
    form({ nowMs: now })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByLabelText('Use by').min).toBe('2026-10-26')
    expect(screen.getByLabelText('Use by').max).toBe('2027-10-25')
    cleanup()
    const nyNight = Date.parse('2026-11-01T03:30:00Z') // 03:30 GMT on 1 Nov in Dublin; 23:30 EDT on 31 Oct in New York
    form({ nowMs: nyNight, zone: NEW_YORK })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByLabelText('Use by').min).toBe('2026-11-01')
    expect(screen.getByLabelText('Use by').value).toBe('2026-11-07')
    expect(summary()).toBe('Adds 1 credit in un1t.online, usable until Sat 7 Nov (7 days).')
    cleanup()
    form({ nowMs: nyNight, zone: DUBLIN })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByLabelText('Use by').min).toBe('2026-11-02')
    expect(screen.getByLabelText('Use by').value).toBe('2026-11-08')
  })
})

describe('sending', () => {
  it('posts the grant, shows the result and asks the card to re-read', async () => {
    const onGranted = vi.fn()
    form({ onGranted })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    fireEvent.click(screen.getByRole('button', { name: 'More credits' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'class_cancelled' } })
    fireEvent.change(screen.getByLabelText('Team note'), { target: { value: ' Tuesday 7am cancelled ' } })
    compAnswer.data.message = 'Added 2 credits in un1t.online, usable until Wed 4 Nov.'
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 credits' }))
    expect(await screen.findByText('Added 2 credits in un1t.online, usable until Wed 4 Nov.')).toBeTruthy()
    const post = calls.find((c) => c.url === '/api/un1t-online/credits/comp')
    expect(post.body).toMatchObject({ contact_id: 'c1', location_id: LOC, amount: 2, use_by: '2026-11-04', reason: 'class_cancelled', note: 'Tuesday 7am cancelled' })
    expect(post.body.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(onGranted).toHaveBeenCalledTimes(1)
    // No WhatsApp: the window is closed.
    expect(calls.some((c) => c.url.startsWith('/api/whatsapp/'))).toBe(false)
  })

  it('with the WhatsApp window open and the box ticked, the studio text goes into the thread', async () => {
    compAnswer.data.chat_template = 'Hi! {credits} added, use them by {date}.'
    form({ canWhatsApp: true, waConversationId: 'conv-1' })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.getByRole('checkbox', { name: /Also send a WhatsApp message about the credits/ }).checked).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'goodwill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 credit' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/whatsapp/conversations/conv-1/send')).toBe(true))
    expect(calls.find((c) => c.url === '/api/whatsapp/conversations/conv-1/send').body).toEqual({ text: 'Hi! 1 complimentary credit added, use them by Wed 4 Nov.' })
    expect(await screen.findByText(/Message sent in the chat\./)).toBeTruthy()
  })

  it('unticked, nothing goes to the thread; the checkbox is not offered with the window closed', async () => {
    form({ canWhatsApp: true, waConversationId: 'conv-1' })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Also send a WhatsApp message/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'goodwill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 credit' }))
    await screen.findByText(/Added 1 credit/)
    expect(calls.some((c) => c.url.startsWith('/api/whatsapp/'))).toBe(false)
    cleanup()
    form({ canWhatsApp: false, waConversationId: 'conv-1' })
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    expect(screen.queryByRole('checkbox', { name: /Also send a WhatsApp message/ })).toBeNull()
  })

  it('an unclear answer shows the server\'s words and keeps the form open', async () => {
    compAnswer = { success: false, error: 'un1t.online did not answer clearly, so the CRM cannot say whether the credits were added. Check the client in un1t.online before trying again.' }
    form()
    fireEvent.click(screen.getByRole('button', { name: /Add complimentary credits/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'goodwill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 credit' }))
    expect(await screen.findByText(/Check the client in un1t.online/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add 1 credit' })).toBeTruthy()
  })
})

describe('Complimentary credits given', () => {
  it('lists date, amount, reason, use-by and who gave it; an unconfirmed grant says so', () => {
    form({
      canGrant: false,
      given: [
        { id: 'w-1', at: '2026-10-20T10:00:00Z', amount: 2, reason: 'Injury', use_by: '2026-10-27', expires_at: '2026-10-27T10:00:00Z', by: 'Aoife', confirmed: true },
        { id: 'w-2', at: '2026-10-25T10:00:00Z', amount: 1, reason: 'Goodwill', use_by: '2026-11-01', expires_at: null, by: null, confirmed: false },
      ],
    })
    expect(screen.getByText('Complimentary credits given')).toBeTruthy()
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items[0]).toBe('20 Oct· 2 credits· Injury· use by Tue 27 Oct· by Aoife')
    expect(items[1]).toMatch(/1 credit· Goodwill· use by Sun 1 Nov· unconfirmed, check un1t.online/)
  })
})
