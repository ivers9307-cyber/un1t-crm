// AGENT-UX.1 — interactive (tap-button) message payloads.
// Meta caps: quick-reply buttons max 3 / titles 20 chars; list messages
// max 10 rows / titles 24 chars. buildInteractivePayload picks the right
// shape from the option count so callers never think about the split.
import { describe, it, expect } from 'vitest'
import { buildInteractivePayload } from './whatsapp'

describe('buildInteractivePayload', () => {
  it('uses quick-reply buttons for 3 or fewer options', () => {
    const p = buildInteractivePayload('353870000000', 'Pick a time:', ['7am', '8am', '9am'])
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('button')
    expect(p.interactive.body.text).toBe('Pick a time:')
    expect(p.interactive.action.buttons).toHaveLength(3)
    expect(p.interactive.action.buttons[0]).toEqual({ type: 'reply', reply: { id: 'opt_0', title: '7am' } })
  })
  it('uses a list for 4-10 options', () => {
    const p = buildInteractivePayload('353870000000', 'Pick a slot:', ['10:00', '10:30', '11:00', '11:30'])
    expect(p.interactive.type).toBe('list')
    expect(p.interactive.action.button).toBeTruthy()
    expect(p.interactive.action.sections[0].rows).toHaveLength(4)
    expect(p.interactive.action.sections[0].rows[3]).toEqual({ id: 'opt_3', title: '11:30' })
  })
  it('truncates titles to the per-shape Meta cap', () => {
    const long = 'a label far too long for any button shape'
    const btn = buildInteractivePayload('1', 'x', ['ok', long])
    expect(btn.interactive.action.buttons[1].reply.title.length).toBeLessThanOrEqual(20)
    const list = buildInteractivePayload('1', 'x', ['a', 'b', 'c', long])
    expect(list.interactive.action.sections[0].rows[3].title.length).toBeLessThanOrEqual(24)
  })
  it('caps a list at 10 rows', () => {
    const many = Array.from({ length: 14 }, (_, i) => `slot ${i}`)
    const p = buildInteractivePayload('1', 'x', many)
    expect(p.interactive.action.sections[0].rows).toHaveLength(10)
  })
})
