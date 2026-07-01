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
