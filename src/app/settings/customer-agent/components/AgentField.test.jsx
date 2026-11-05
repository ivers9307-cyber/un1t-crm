// @vitest-environment jsdom
//
// MIASETTINGS.1c — the one field component the Mia settings render from the
// registry (fields.js), and the source tag beside an inheritable field. The
// value mapping per kind is what buildSavePayload expects, so a field drawn
// from the registry saves exactly what the hand-written input did.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AgentField from './AgentField'
import SourceTag from './SourceTag'
import { fieldsFor } from '../fields'

afterEach(cleanup)

const CTX = { membershipSourceKey: 'un1t_online', bookings: true, brand: { companyName: 'Acme Gym', shortName: 'Acme' }, agentName: 'Zoe' }
const byId = (id, ctx = CTX) => fieldsFor('studio', null, ctx).find((f) => f.id === id)

function mount(field, value, extra = {}) {
  const onChange = vi.fn()
  render(<AgentField field={field} ctx={CTX} value={value} onChange={onChange} {...extra} />)
  return onChange
}

describe('AgentField: value mapping per kind', () => {
  it('text: shows the stored string, hands back the raw string typed (spaces kept)', () => {
    const f = byId('agent_name')
    const onChange = mount(f, 'Mia')
    const input = screen.getByLabelText(f.label)
    expect(input.tagName).toBe('INPUT')
    expect(input.value).toBe('Mia')
    expect(input.getAttribute('maxlength')).toBe('40')
    fireEvent.change(input, { target: { value: '  Maya ' } })
    expect(onChange).toHaveBeenCalledWith('agent_name', '  Maya ')
  })

  it('text: null shows blank; a cleared field hands back ""', () => {
    const f = byId('membership_signup_url')
    const onChange = mount(f, 'https://x.test')
    fireEvent.change(screen.getByLabelText(f.label), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('membership_signup_url', '')
    cleanup()
    mount(f, null)
    expect(screen.getByLabelText(f.label).value).toBe('')
  })

  it('text with inputType url renders an url input', () => {
    const f = byId('booking_url')
    mount(f, '')
    expect(screen.getByLabelText(f.label).getAttribute('type')).toBe('url')
  })

  it('textarea: a textarea, raw string', () => {
    const f = byId('tone')
    const onChange = mount(f, 'Warm')
    const input = screen.getByLabelText(f.label)
    expect(input.tagName).toBe('TEXTAREA')
    expect(input.value).toBe('Warm')
    fireEvent.change(input, { target: { value: 'Brief' } })
    expect(onChange).toHaveBeenCalledWith('tone', 'Brief')
  })

  it('number: "" -> null, a typed number -> Number, 0 kept', () => {
    const f = byId('handoff_cooldown_hours')
    const onChange = mount(f, 12)
    const input = screen.getByLabelText(f.label)
    expect(input.getAttribute('type')).toBe('number')
    expect(input.getAttribute('min')).toBe('0')
    expect(input.getAttribute('max')).toBe('168')
    expect(input.value).toBe('12')
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('handoff_cooldown_hours', null)
    fireEvent.change(input, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith('handoff_cooldown_hours', 0)
    fireEvent.change(input, { target: { value: '7' } })
    expect(onChange).toHaveBeenLastCalledWith('handoff_cooldown_hours', 7)
  })

  it('number: null shows blank, and a placeholder passed in wins over the field\'s', () => {
    const f = byId('handoff_cooldown_hours')
    mount(f, null, { placeholder: '24' })
    const input = screen.getByLabelText(f.label)
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('24')
  })

  it('select: "" -> null, an option -> its value; null shows the "" option', () => {
    const f = byId('effort')
    const onChange = mount(f, null)
    const select = screen.getByLabelText(f.label)
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('')
    fireEvent.change(select, { target: { value: 'high' } })
    expect(onChange).toHaveBeenLastCalledWith('effort', 'high')
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('effort', null)
  })

  it('select with no "" option shows the first option for a value it does not list', () => {
    const f = byId('booking_mode')
    mount(f, null)
    expect(screen.getByLabelText(f.label).value).toBe('auto')
    cleanup()
    mount(f, 'draft')
    expect(screen.getByLabelText(f.label).value).toBe('draft')
  })

  it('checkbox: checked from the value, hands back a boolean', () => {
    const f = byId('social_enabled')
    const onChange = mount(f, false)
    const box = screen.getByLabelText(f.label)
    expect(box.type).toBe('checkbox')
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith('social_enabled', true)
  })

  it('checkbox checkedByDefault (inline suggestions): anything but false reads as on', () => {
    const f = byId('inline_suggestion.enabled')
    for (const [value, checked] of [[undefined, true], [null, true], [true, true], [false, false]]) {
      const onChange = mount(f, value)
      const box = screen.getByLabelText(f.label)
      expect(box.checked, String(value)).toBe(checked)
      fireEvent.click(box)
      expect(onChange).toHaveBeenCalledWith('inline_suggestion.enabled', !checked)
      cleanup()
    }
  })
})

describe('AgentField: label, help, placeholder, error', () => {
  it('the label is tied to the input, with or without a tag beside it', () => {
    const f = byId('tone')
    mount(f, '', { tag: <span>Organisation default</span> })
    expect(screen.getByLabelText('Tone and voice').tagName).toBe('TEXTAREA')
    // the tag sits in the label's row
    expect(screen.getByText('Tone and voice').parentElement.textContent).toContain('Organisation default')
  })

  it('a field with no tag puts its label straight in the field\'s block (the input under the same parent)', () => {
    const f = byId('monthly_points_target')
    mount(f, 3000)
    const row = screen.getByText(f.label).parentElement
    expect(row.querySelector('input[type="number"]').value).toBe('3000')
  })

  it('a placeholder or label function receives ctx', () => {
    const placeholder = vi.fn((ctx) => `Hi from ${ctx.brand.companyName}`)
    const label = vi.fn((ctx) => `Message for ${ctx.agentName}`)
    const f = { id: 'x', paths: ['x'], kind: 'text', label, placeholder }
    mount(f, '')
    expect(placeholder).toHaveBeenCalledWith(CTX)
    expect(label).toHaveBeenCalledWith(CTX)
    expect(screen.getByLabelText('Message for Zoe').getAttribute('placeholder')).toBe('Hi from Acme Gym')
  })

  it('the help shows under the field', () => {
    const f = byId('holding_message')
    mount(f, '')
    expect(screen.getByText(f.help)).toBeTruthy()
  })

  it('an error renders role="alert" and marks the input invalid', () => {
    const f = byId('booking_url')
    mount(f, 'nope', { error: 'Enter a full link starting with https:// (or http://).' })
    expect(screen.getByRole('alert').textContent).toBe('Enter a full link starting with https:// (or http://).')
    expect(screen.getByLabelText(f.label).getAttribute('aria-invalid')).toBe('true')
  })

  it('no error: no alert, not marked invalid', () => {
    const f = byId('booking_url')
    mount(f, 'https://ok.test')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText(f.label).getAttribute('aria-invalid')).toBeNull()
  })

  it('disabled disables the control', () => {
    const f = byId('tone')
    mount(f, '', { disabled: true })
    expect(screen.getByLabelText(f.label).disabled).toBe(true)
  })
})

describe('SourceTag (today\'s sourceTag output)', () => {
  it('an inherited field shows its source', () => {
    render(<SourceTag source="org" canEdit orgHas onRevert={() => {}} />)
    expect(screen.getByText('Organisation default')).toBeTruthy()
    cleanup()
    render(<SourceTag source="default" canEdit orgHas={false} onRevert={() => {}} />)
    expect(screen.getByText('Default')).toBeTruthy()
  })

  it('the studio\'s own field offers the way back, worded by whether the organisation sets it', () => {
    const onRevert = vi.fn()
    render(<SourceTag source="studio" canEdit orgHas onRevert={onRevert} />)
    const b = screen.getByRole('button', { name: 'Use organisation default' })
    expect(b.getAttribute('type')).toBe('button')
    fireEvent.click(b)
    expect(onRevert).toHaveBeenCalledTimes(1)
    cleanup()
    render(<SourceTag source="studio" canEdit orgHas={false} onRevert={onRevert} />)
    expect(screen.getByRole('button', { name: 'Use default' })).toBeTruthy()
  })

  it('a read-only viewer sees nothing for the studio\'s own field', () => {
    const { container } = render(<SourceTag source="studio" canEdit={false} orgHas onRevert={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
