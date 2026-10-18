// @vitest-environment jsdom
//
// WAORGNUMBER.1 (Task 6, R8) — the studio's switches over the organisation's
// numbers: on/off, the default radio, the route's refusal, and the confirm
// before a studio switches off its last number. Ids are synthetic.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import StudioWhatsAppNumbers from './StudioWhatsAppNumbers.jsx'

const LOC = 'a0000000-0000-4000-8000-000000000002'
const URL_ = `/api/locations/${LOC}/whatsapp/numbers`
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const N = (id, label, over = {}) => ({ id, label, display_phone: null, is_active: true, on: false, is_default: false, ...over })

let putBodies
function mockServer({ initial, putAnswer }) {
  putBodies = []
  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(init.body))
      return putAnswer(putBodies.at(-1))
    }
    return reply(200, { success: true, data: { numbers: initial } })
  })
}

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.fetch })

describe('StudioWhatsAppNumbers', () => {
  it('switching a number on PUTs { numberId, on:true } and shows the answer', async () => {
    const after = [N('n1', 'Front desk', { on: true, is_default: true }), N('n2', 'Second')]
    mockServer({ initial: [N('n1', 'Front desk'), N('n2', 'Second')], putAnswer: () => reply(200, { success: true, data: { numbers: after } }) })
    const onChanged = vi.fn()
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch onChanged={onChanged} />)
    fireEvent.click(await screen.findByLabelText('Switch on Front desk at this studio'))
    await waitFor(() => expect(screen.getByLabelText('Switch on Front desk at this studio').checked).toBe(true))
    expect(putBodies).toEqual([{ numberId: 'n1', on: true }])
    expect(global.fetch.mock.calls.at(-1)[0]).toBe(URL_)
    expect(screen.getByLabelText('Make Front desk the default at this studio').checked).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('the default radio PUTs { on:true, isDefault:true }', async () => {
    const initial = [N('n1', 'Front desk', { on: true, is_default: true }), N('n2', 'Second', { on: true })]
    const after = [N('n1', 'Front desk', { on: true }), N('n2', 'Second', { on: true, is_default: true })]
    mockServer({ initial, putAnswer: () => reply(200, { success: true, data: { numbers: after } }) })
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    fireEvent.click(await screen.findByLabelText('Make Second the default at this studio'))
    await waitFor(() => expect(screen.getByLabelText('Make Second the default at this studio').checked).toBe(true))
    expect(putBodies).toEqual([{ numberId: 'n2', on: true, isDefault: true }])
  })

  it('switching off the only number asks first, and a "no" writes nothing', async () => {
    mockServer({ initial: [N('n1', 'Front desk', { on: true, is_default: true })], putAnswer: () => reply(200, { success: true, data: { numbers: [] } }) })
    window.confirm.mockReturnValue(false)
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    fireEvent.click(await screen.findByLabelText('Switch on Front desk at this studio'))
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(String(window.confirm.mock.calls[0][0])).toMatch(/only number on at this studio/)
    expect(putBodies).toEqual([])
  })

  it('switching off one of two does not ask', async () => {
    const initial = [N('n1', 'Front desk', { on: true, is_default: true }), N('n2', 'Second', { on: true })]
    mockServer({ initial, putAnswer: () => reply(200, { success: true, data: { numbers: [N('n1', 'Front desk', { on: true, is_default: true }), N('n2', 'Second')] } }) })
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    fireEvent.click(await screen.findByLabelText('Switch on Second at this studio'))
    await waitFor(() => expect(putBodies).toEqual([{ numberId: 'n2', on: false }]))
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('a refused change shows the route error and leaves the list as it was', async () => {
    mockServer({ initial: [N('n1', 'Front desk')], putAnswer: () => reply(403, { success: false, error: 'Only an owner or manager can switch WhatsApp numbers on or off at this studio.' }) })
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    fireEvent.click(await screen.findByLabelText('Switch on Front desk at this studio'))
    expect(await screen.findByText(/Only an owner or manager can switch/)).toBeTruthy()
    expect(screen.getByLabelText('Switch on Front desk at this studio').checked).toBe(false)
  })

  it('numbers exist but none is on: says so, and offers the switch to someone who can', async () => {
    mockServer({ initial: [N('n1', 'Front desk')], putAnswer: () => reply(200, { success: true, data: { numbers: [] } }) })
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    expect(await screen.findByText(/No number is switched on here/)).toBeTruthy()
    expect(screen.getByText(/Switch one on below/)).toBeTruthy()
  })

  it('a failed read shows Try again and no switches', async () => {
    global.fetch = vi.fn(async () => reply(500, { success: false, error: 'boom' }))
    render(<StudioWhatsAppNumbers locationId={LOC} canSwitch />)
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
