// @vitest-environment jsdom
//
// CHARITY.9 — the event form's "Charity day" section: loads race_events.charity_enabled /
// charity, shows presets as comma-separated euros, and saves them back as cents in the
// order typed. Blank text fields are omitted (defaults apply); the charity object is sent
// on every save, switch on or off.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }) }))

const EVENT = {
  id: 'ev-1', kind: 'open_day', name: 'Opening Day', slug: 'opening-day', race_date: '2026-10-03',
  allowed_team_sizes: [1], capacity_mode: 'people', active: true,
  waves: [{ id: 'w9', start_time: '09:00:00', capacity: 28, label: null }],
  charity_enabled: true,
  charity: { name: 'MS Ireland', presets_cents: [1000, 2500], match_multiplier: 2 },
}

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    if (opts?.method === 'PUT' || opts?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    return new Promise(() => {})
  }))
  return calls
}

async function submitAndGetBody(container, calls) {
  fireEvent.submit(container.querySelector('form'))
  await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
  return JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — Charity day', () => {
  it('loads the saved settings and sends them back (presets as cents, in order)', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    expect(screen.getByText('Charity day')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /charity day/i }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Preset amounts (€)').value).toBe('10, 25')
    expect(screen.getByLabelText('Charity name').value).toBe('MS Ireland')
    expect(screen.getByLabelText('Match multiplier').value).toBe('2')
    const body = await submitAndGetBody(container, calls)
    expect(body.charity_enabled).toBe(true)
    expect(body.charity.presets_cents).toEqual([1000, 2500])
    expect(body.charity.match_multiplier).toBe(2)
    expect(body.charity.name).toBe('MS Ireland')
  })

  it('keeps the order the operator typed and converts euros to cents', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Preset amounts (€)'), { target: { value: '50, 5.5, , 20' } })
    fireEvent.change(screen.getByLabelText('Minimum custom amount (€)'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Maximum custom amount (€)'), { target: { value: '1000' } })
    fireEvent.change(screen.getByLabelText('Goal (€)'), { target: { value: '5000' } })
    const body = await submitAndGetBody(container, calls)
    expect(body.charity.presets_cents).toEqual([5000, 550, 2000])
    expect(body.charity.min_cents).toBe(200)
    expect(body.charity.max_cents).toBe(100000)
    expect(body.charity.goal_cents).toBe(500000)
  })

  it('omits blank text fields and a blank goal (never null)', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    const body = await submitAndGetBody(container, calls)
    for (const k of ['heading', 'blurb', 'match_label', 'consent_label', 'thank_you_title', 'thank_you_body', 'thank_you_body_unmatched', 'receipt_subject', 'receipt_intro', 'goal_cents']) {
      expect(k in body.charity).toBe(false)
    }
    expect(JSON.stringify(body.charity)).not.toContain('null')
  })

  it('sends text fields once typed', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Give a rep' } })
    fireEvent.change(screen.getByLabelText('Thank-you title'), { target: { value: 'Cheers {{first_name}}' } })
    const body = await submitAndGetBody(container, calls)
    expect(body.charity.heading).toBe('Give a rep')
    expect(body.charity.thank_you_title).toBe('Cheers {{first_name}}')
  })

  it('unticked sends charity_enabled false and still sends the charity object', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.click(screen.getByRole('switch', { name: /charity day/i }))
    const body = await submitAndGetBody(container, calls)
    expect(body.charity_enabled).toBe(false)
    expect(body.charity.presets_cents).toEqual([1000, 2500])
    expect(body.charity.name).toBe('MS Ireland')
  })

  it('a non-number preset shows an inline error and blocks the save', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Preset amounts (€)'), { target: { value: '10, abc' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(container.textContent).toMatch(/preset/i))
    expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(false)
  })

  it('blank presets with a low maximum names the default preset and the maximum, and blocks the save', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Preset amounts (€)'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Maximum custom amount (€)'), { target: { value: '50' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(container.textContent).toContain('default preset €100.00 is above your maximum €50.00'))
    expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(false)
  })

  it('a typed preset below the minimum names it', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Minimum custom amount (€)'), { target: { value: '20' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(container.textContent).toContain('the preset €10.00 is below your minimum €20.00'))
    expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(false)
  })

  it('an event with the section off sends charity_enabled false and a settings object', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...EVENT, charity_enabled: false, charity: null }} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: /charity day/i }).getAttribute('aria-checked')).toBe('false')
    const body = await submitAndGetBody(container, calls)
    expect(body.charity_enabled).toBe(false)
    expect(body.charity).toBeTruthy()
  })
})
