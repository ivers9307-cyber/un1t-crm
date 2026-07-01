import { describe, it, expect } from 'vitest'
import { SCREEN, dayScreen, slotScreen, detailsScreen, FLOW_JSON } from './screens.js'

describe('flow screens', () => {
  it('dayScreen lists days as radio options', () => {
    const res = dayScreen([{ id: '2026-07-03', title: 'Thu 3 Jul' }])
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.days).toEqual([{ id: '2026-07-03', title: 'Thu 3 Jul' }])
  })

  it('slotScreen carries the chosen day through', () => {
    const res = slotScreen({ day: '2026-07-03', slots: [{ id: 'c1', title: '18:00 HIIT (4 left)' }] })
    expect(res.screen).toBe(SCREEN.SLOT)
    expect(res.data.day).toBe('2026-07-03')
    expect(res.data.slots[0].id).toBe('c1')
  })

  it('detailsScreen prefills known contact fields', () => {
    const res = detailsScreen({ name: 'Ann', email: 'ann@x.ie' })
    expect(res.data.name).toBe('Ann')
    expect(res.data.email).toBe('ann@x.ie')
    expect(res.data.marketing_opt_in).toBe(true)
  })

  it('FLOW_JSON declares all five screens and is terminal at CONFIRM', () => {
    const ids = FLOW_JSON.screens.map((s) => s.id)
    expect(ids).toEqual([SCREEN.PATH, SCREEN.DAY, SCREEN.SLOT, SCREEN.DETAILS, SCREEN.CONFIRM])
    expect(FLOW_JSON.screens.find((s) => s.id === SCREEN.CONFIRM).terminal).toBe(true)
  })
})

// Guards the v7.3-schema requirements that WhatsApp Flow Builder rejects otherwise
// (each of these was a real Builder error when the JSON was published).
describe('FLOW_JSON v7.3 schema requirements', () => {
  const byId = Object.fromEntries(FLOW_JSON.screens.map((s) => [s.id, s]))

  it('declares Flow JSON version 7.3', () => {
    expect(FLOW_JSON.version).toBe('7.3')
  })

  it('array screen data declares an items schema', () => {
    expect(byId.DAY.data.days.items?.properties).toMatchObject({ id: { type: 'string' }, title: { type: 'string' } })
    expect(byId.SLOT.data.slots.items?.properties).toMatchObject({ id: { type: 'string' }, title: { type: 'string' } })
  })

  it('DETAILS prefills via Form init-values, never per-input init-value', () => {
    const form = byId.DETAILS.layout.children[0]
    expect(form['init-values']).toMatchObject({ name: '${data.name}', email: '${data.email}', marketing_opt_in: '${data.marketing_opt_in}' })
    form.children
      .filter((c) => c.type === 'TextInput' || c.type === 'OptIn')
      .forEach((c) => expect(c['init-value']).toBeUndefined())
  })

  it('CONFIRM selection declares sub-properties so ${data.selection.*} resolves', () => {
    expect(Object.keys(byId.CONFIRM.data.selection.properties)).toEqual(
      expect.arrayContaining(['path', 'slot', 'name', 'email', 'marketing_opt_in']),
    )
  })
})
