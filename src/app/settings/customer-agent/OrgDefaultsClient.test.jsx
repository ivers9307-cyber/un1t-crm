// @vitest-environment jsdom
//
// MIAORG.1 Task 4 — the organisation defaults editor. Each field names the
// studios that use the org value and those that set their own (T4-A); before
// a save, the studios that START using a newly set value are named; the
// copy action previews, then copies; nothing studio-only is ever sent.
// Fictional ids and names.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { DEFAULTS } from '@/lib/agent/settings-contract'
import { mergeAgentSettings } from '@/lib/agent/settings-resolve'
import OrgDefaultsClient from './OrgDefaultsClient.jsx'
import { ORG_PAYLOAD_DROPPED_KEYS } from './save-payload'

const ORG = 'a0000000-0000-0000-0000-00000000a0a1'
const NORTH = { id: 'a0000000-0000-0000-0000-0000000000c1', name: 'North Studio', sets: ['followups.daily_cap', 'quiet_hours.off', 'tone'], mia_on: true }
const SOUTH = { id: 'a0000000-0000-0000-0000-0000000000c2', name: 'South Studio', sets: [], mia_on: false }

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const ORG_DEFAULTS = Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => !['enabled', 'test_mode', 'test_phones', 'booking_mode', 'consultation_event_type_id', 'cancellation_form', 'booking_url', 'booking_cta_label', 'membership_signup_url', 'membership_cta_label'].includes(k)))

function state(raw = null, studios = [NORTH, SOUTH]) {
  const { settings } = mergeAgentSettings({ org: raw, studio: null })
  for (const k of ['enabled', 'test_mode', 'test_phones', 'booking_mode', 'consultation_event_type_id', 'cancellation_form', 'booking_url', 'booking_cta_label', 'membership_signup_url', 'membership_cta_label']) delete settings[k]
  return { success: true, data: { organization: { id: ORG, name: 'Org A' }, settings, raw, defaults: ORG_DEFAULTS, studios } }
}

function mockFetch(answers) {
  let i = 0
  global.fetch = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  })
}
const puts = () => global.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => ({ url, body: JSON.parse(init.body) }))
const ready = () => waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
const fieldBox = (id, container) => container.querySelector(`[data-org-field="${id}"]`)

afterEach(() => { cleanup(); delete global.fetch })

describe('OrgDefaultsClient — the section', () => {
  it('reads the org route for its organisation and says what the defaults are', async () => {
    mockFetch([reply(200, state())])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} organizationName="Org A" />)
    await ready()
    expect(global.fetch.mock.calls[0][0]).toBe(`/api/settings/customer-agent/org?organization_id=${ORG}`)
    expect(screen.getByRole('heading', { name: 'Organisation defaults (all studios)' })).toBeTruthy()
    expect(screen.getByText(/^Studios use these unless they set their own\./)).toBeTruthy()
    // T4-F — no em-dashes in this section's copy
    expect(container.textContent).not.toMatch(/—/)
    // no studio-only field is offered
    for (const label of ['Live — reply to all customers', 'Class bookings', 'Membership sign-up link']) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it('a failed read shows Could not load and no Save', async () => {
    mockFetch([reply(500, { success: false, code: 'org_settings_unreadable' })])
    render(<OrgDefaultsClient organizationId={ORG} />)
    await waitFor(() => expect(screen.getByText(/Could not load the organisation defaults just now/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save organisation defaults' })).toBeNull()
  })
})

describe('OrgDefaultsClient — who inherits (T4-A)', () => {
  it('each field names the studios using the org value and those setting their own, Mia off labelled', async () => {
    mockFetch([reply(200, state())])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    expect(within(fieldBox('quiet_hours', container)).getByText('Used by South Studio (Mia off). North Studio sets its own.')).toBeTruthy()
    expect(within(fieldBox('agent_name', container)).getByText('Used by North Studio and South Studio (Mia off).')).toBeTruthy()
  })

  it('setting quiet hours where the org had none names, before Save, the studios that start using them', async () => {
    mockFetch([reply(200, state()), reply(200, state({ quiet_hours: { start: '22:00', end: '07:00' } }))])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    expect(screen.queryByTestId('org-newly-applied')).toBeNull()
    const box = fieldBox('quiet_hours', container)
    fireEvent.change(within(box).getByLabelText('Quiet hours start'), { target: { value: '22:00' } })
    fireEvent.change(within(box).getByLabelText('Quiet hours end'), { target: { value: '07:00' } })
    const notice = screen.getByTestId('org-newly-applied')
    // North switched quiet hours off for itself: it is not named
    expect(within(notice).getByText('Quiet hours (optional): South Studio (Mia off) will start using this.')).toBeTruthy()
    expect(notice.textContent).not.toContain('North Studio')

    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    const [{ url, body }] = puts()
    expect(url).toBe('/api/settings/customer-agent/org')
    expect(body.organization_id).toBe(ORG)
    // T4-B — no zone: each studio's own clock
    expect(body.settings.quiet_hours).toEqual({ start: '22:00', end: '07:00', tz: null })
    expect(body.overridden).toEqual(['quiet_hours.end', 'quiet_hours.start'])
    for (const k of ORG_PAYLOAD_DROPPED_KEYS) expect(body.settings, k).not.toHaveProperty(k)
    // after the save the notice is gone: the org now has the value
    await waitFor(() => expect(screen.queryByTestId('org-newly-applied')).toBeNull())
  })

  it('changing a value the org already set is not a new application', async () => {
    mockFetch([reply(200, state({ tone: 'Org tone' }))])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    fireEvent.change(within(fieldBox('tone', container)).getByRole('textbox'), { target: { value: 'New tone' } })
    expect(screen.queryByTestId('org-newly-applied')).toBeNull()
  })

  it('"Use default" stops the organisation setting a field', async () => {
    mockFetch([reply(200, state({ tone: 'Org tone', agent_name: 'Ava' })), reply(200, state({ agent_name: 'Ava' }))])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    const tone = fieldBox('tone', container)
    expect(within(tone).getByRole('textbox').value).toBe('Org tone')
    fireEvent.click(within(tone).getByRole('button', { name: 'Use default' }))
    expect(within(tone).getByRole('textbox').value).toBe('')
    expect(within(tone).getByText('Default')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body.overridden).toEqual(['agent_name'])
  })

  it('a stored value the editor has no input for (limits) is echoed on Save, never dropped', async () => {
    mockFetch([reply(200, state({ limits: { max_replies_per_location_per_day: 200 } }))])
    render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body.overridden).toEqual(['limits.max_replies_per_location_per_day'])
    expect(puts()[0].body.settings.limits).toEqual({ max_replies_per_location_per_day: 200 })
  })

  it('calls onSaved after a good save, so the studio editor re-reads what it inherits', async () => {
    const onSaved = vi.fn(async () => {})
    mockFetch([reply(200, state()), reply(200, state({ tone: 'Warm' }))])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} onSaved={onSaved} />)
    await ready()
    fireEvent.change(within(fieldBox('tone', container)).getByRole('textbox'), { target: { value: 'Warm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })
})

describe('OrgDefaultsClient — Start from a studio\'s settings (T4-C)', () => {
  it('previews what the copy sets and who starts using it, then copies on Copy now', async () => {
    mockFetch([reply(200, state()), reply(200, state({ tone: 'North tone', followups: { daily_cap: 30 } }))])
    render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    fireEvent.change(screen.getByLabelText("Start from a studio's settings"), { target: { value: NORTH.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Review copy' }))
    // North's own paths minus its quiet-hours opt-out: tone and the follow-up cap
    expect(screen.getByText('This sets 2 organisation values from North Studio: Tone and voice, Daily cap (per studio).')).toBeTruthy()
    expect(screen.getByText('Tone and voice: South Studio (Mia off) will start using this.')).toBeTruthy()
    expect(puts()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Copy now' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toEqual({ organization_id: ORG, copy_from_location_id: NORTH.id })
  })

  it('a studio that sets nothing has nothing to copy', async () => {
    mockFetch([reply(200, state())])
    render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    fireEvent.change(screen.getByLabelText("Start from a studio's settings"), { target: { value: SOUTH.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Review copy' }))
    expect(screen.getByText('South Studio sets none of these values itself, so there is nothing to copy.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy now' })).toBeNull()
  })
})

describe('OrgDefaultsClient — fix round', () => {
  it('a half-entered quiet-hours window says "Set both times" and holds Save', async () => {
    mockFetch([reply(200, state())])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    const box = fieldBox('quiet_hours', container)
    fireEvent.change(within(box).getByLabelText('Quiet hours start'), { target: { value: '22:00' } })
    expect(within(box).getByText('Set both times')).toBeTruthy()
    const saveBtn = screen.getByRole('button', { name: 'Save organisation defaults' })
    expect(saveBtn.disabled).toBe(true)
    // a half window stores nothing, so it is not in the notice either
    expect(screen.queryByTestId('org-newly-applied')).toBeNull()
    fireEvent.change(within(box).getByLabelText('Quiet hours end'), { target: { value: '07:00' } })
    expect(within(box).queryByText('Set both times')).toBeNull()
    expect(saveBtn.disabled).toBe(false)
  })

  it('a field typed and then cleared is not in the pre-save notice', async () => {
    mockFetch([reply(200, state())])
    const { container } = render(<OrgDefaultsClient organizationId={ORG} />)
    await ready()
    const tone = within(fieldBox('tone', container)).getByRole('textbox')
    fireEvent.change(tone, { target: { value: 'Warm' } })
    expect(screen.getByTestId('org-newly-applied')).toBeTruthy()
    fireEvent.change(tone, { target: { value: '' } })
    expect(screen.queryByTestId('org-newly-applied')).toBeNull()
  })
})
