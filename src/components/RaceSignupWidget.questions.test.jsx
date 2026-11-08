// @vitest-environment jsdom
// QUESTIONS.1 — the signup form asks the event's questions: entry questions
// once, person questions under each person; a missing required answer stops
// the submit with a field error; the body carries answers in roster order.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const diet = { id: 'q-diet', label: 'Dietary needs', type: 'text', required: false, per: 'person' }
const level = { id: 'q-level', label: 'Experience', type: 'choice', options: ['Beginner', 'Advanced'], required: true, per: 'person' }
const photos = { id: 'q-photos', label: 'OK to be photographed?', type: 'yes_no', required: true, per: 'entry' }
const RACE = {
  id: 'ev-1', name: 'Mobility', slug: 'mob', kind: 'workshop', race_date: '2026-12-05',
  allowed_team_sizes: [1, 2], capacity_mode: 'people',
  waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null,
  registration_questions: [diet, level, photos],
}
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body })
function serve(data) {
  const fetchMock = vi.fn((url) => {
    if (String(url).endsWith('/register')) return Promise.resolve(jsonRes({ success: true, data: { registration_id: 'r1', payment: { free: true } } }))
    return Promise.resolve(jsonRes({ success: true, data }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
let container
async function renderWidget(data = RACE) {
  const fetchMock = serve(data)
  ;({ container } = render(<RaceSignupWidget slug="mob" />))
  await screen.findByPlaceholderText('Your email *')
  return fetchMock
}
// The page has two submit buttons (the form's and the mobile sticky bar's);
// submit the form itself.
const submit = () => fireEvent.submit(container.querySelector('form'))
function fillCaptain() {
  fireEvent.change(screen.getByPlaceholderText('Your name *'), { target: { value: 'Aoife Byrne' } })
  fireEvent.change(screen.getByPlaceholderText('Your email *'), { target: { value: 'aoife@example.test' } })
  fireEvent.change(screen.getByPlaceholderText(/phone/i), { target: { value: '0870000000' } })
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — registration questions', () => {
  it('renders the entry question once and the person questions for the one person', async () => {
    await renderWidget()
    expect(screen.getAllByText(/OK to be photographed\?/)).toHaveLength(1)
    expect(screen.getAllByLabelText(/Experience/)).toHaveLength(1)
    expect(screen.getAllByLabelText(/Dietary needs/)).toHaveLength(1)
  })
  it('a missing required answer stops the submit with a field error; answered, it posts answers in roster order', async () => {
    const fetchMock = await renderWidget()
    fillCaptain()
    submit()
    expect(await screen.findByText(/Experience is required/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/register'))).toBe(false)

    fireEvent.change(screen.getByLabelText(/Experience/), { target: { value: 'Beginner' } })
    fireEvent.click(screen.getByLabelText(/^Yes$/))
    fireEvent.change(screen.getByLabelText(/Dietary needs/), { target: { value: 'vegan' } })
    submit()
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/register'))).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/register'))
    expect(JSON.parse(init.body).answers).toEqual({ entry: { 'q-photos': true }, people: [{ 'q-diet': 'vegan', 'q-level': 'Beginner' }] })
  })
  it('a second person gets their own person questions', async () => {
    await renderWidget()
    const pill = screen.getAllByRole('button').find((b) => /^2\b/.test(b.textContent.trim()))
    fireEvent.click(pill)
    expect(screen.getAllByLabelText(/Experience/)).toHaveLength(2)
    expect(screen.getAllByText(/OK to be photographed\?/)).toHaveLength(1)
  })
  it('an event without questions renders no question fields', async () => {
    await renderWidget({ ...RACE, registration_questions: null })
    expect(screen.queryByLabelText(/Experience/)).toBeNull()
  })
})
