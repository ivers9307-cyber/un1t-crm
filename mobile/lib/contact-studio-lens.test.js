import { describe, it, expect } from 'vitest'
import { lensView, platformWord } from './contact-studio-lens.js'

const TAGS = { h: 'Hatch Street', s: 'Stillorgan' }
const OPTIONS = [
  { location_id: 's', name: 'UN1T Stillorgan', platform: 'glofox', primary: true },
  { location_id: 'h', name: 'UN1T Hatch Street', platform: 'un1t_online', primary: false },
]

describe('lensView', () => {
  it('an older server, a legacy bundle, or no bundle: no lens and nothing sent', () => {
    for (const b of [{ success: true }, 'loading', 'error', null, { lens: 'legacy', studio_options: OPTIONS }]) {
      expect(lensView(b)).toMatchObject({ hasLens: false, showSwitcher: false, sendLocationId: null, footer: null })
    }
  })

  it('two studios: a switcher, the acting one sends, a footer naming it', () => {
    const v = lensView({ lens: 'studio', acting_studio: { location_id: 'h', name: 'UN1T Hatch Street' }, studio_options: OPTIONS, studio_tags: TAGS })
    expect(v.showSwitcher).toBe(true)
    expect(v.options.map((o) => o.label)).toEqual(['Stillorgan', 'Hatch Street'])
    expect(v.actingId).toBe('h')
    expect(v.sendLocationId).toBe('h')
    expect(v.footer).toBe('Sends from the Hatch Street number. Notes and tasks file at Hatch Street.')
  })

  it('one option (a Hatch-only coach): no switcher, still sends for Hatch, footer when the person has two studios', () => {
    const v = lensView({ lens: 'studio', acting_studio: { location_id: 'h', name: 'UN1T Hatch Street' }, studio_options: [OPTIONS[1]], studio_tags: TAGS })
    expect(v.showSwitcher).toBe(false)
    expect(v.sendLocationId).toBe('h')
    expect(v.footer).toMatch(/Hatch Street number/)
  })

  it('a one-studio person: no footer', () => {
    const v = lensView({ lens: 'studio', acting_studio: { location_id: 's', name: 'UN1T Stillorgan' }, studio_options: [OPTIONS[0]], studio_tags: {} })
    expect(v.footer).toBeNull()
    expect(v.actingLabel).toBe('UN1T Stillorgan')
  })

  it('All studios: acts nowhere', () => {
    const v = lensView({ lens: 'all', acting_studio: null, studio_options: OPTIONS, studio_tags: TAGS })
    expect(v).toMatchObject({ isAll: true, actingId: null, sendLocationId: null })
    expect(v.footer).toBe('Choose a studio to message, add a note or a task.')
  })
})

describe('platformWord', () => {
  it('names the two platforms, nothing else', () => {
    expect(platformWord('glofox')).toBe('Glofox')
    expect(platformWord('un1t_online')).toBe('un1t.online')
    expect(platformWord('none')).toBeNull()
  })
})
