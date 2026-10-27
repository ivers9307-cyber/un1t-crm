import { describe, it, expect } from 'vitest'
import { glofoxCardMode } from './contact-platforms.js'

describe('glofoxCardMode (CARDLENS.1)', () => {
  it('a Glofox-linked contact keeps the card, whatever its primary studio runs', () => {
    expect(glofoxCardMode({ contact: { glofox_member_id: 'gx-1' }, primarySource: 'glofox' })).toBe('linked')
    expect(glofoxCardMode({ contact: { glofox_member_id: 'gx-1' }, primarySource: 'un1t_online' })).toBe('linked')
  })

  it('an unlinked contact at a Glofox studio can be pushed', () => {
    expect(glofoxCardMode({ contact: { glofox_member_id: null }, primarySource: 'glofox' })).toBe('pushable')
  })

  it('an unlinked contact at a un1t.online studio sees no Glofox card', () => {
    expect(glofoxCardMode({ contact: { glofox_member_id: null }, primarySource: 'un1t_online' })).toBe('hidden')
  })

  it('an unlinked contact at a studio with no membership source sees no Glofox card', () => {
    expect(glofoxCardMode({ contact: {}, primarySource: 'none' })).toBe('hidden')
  })

  it('an unreadable source keeps the push button (the route refuses it anyway)', () => {
    expect(glofoxCardMode({ contact: {}, primarySource: null })).toBe('pushable')
  })
})
