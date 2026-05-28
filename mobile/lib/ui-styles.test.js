import { describe, it, expect } from 'vitest'
import {
  buttonClasses, buttonTextClasses, cardClasses,
  BUTTON_VARIANTS, BUTTON_SIZES, CARD_PADDING,
} from './ui-styles.js'

describe('buttonClasses', () => {
  it('defaults to primary + md', () => {
    const c = buttonClasses()
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
  })
  it('applies requested variant + size', () => {
    const c = buttonClasses({ variant: 'danger', size: 'lg' })
    expect(c).toContain(BUTTON_VARIANTS.danger)
    expect(c).toContain(BUTTON_SIZES.lg)
  })
  it('square icon size for icon-only buttons', () => {
    expect(buttonClasses({ size: 'icon' })).toContain(BUTTON_SIZES.icon)
  })
  it('adds opacity when disabled', () => {
    expect(buttonClasses({ disabled: true })).toContain('opacity-50')
    expect(buttonClasses({ disabled: false })).not.toContain('opacity-50')
  })
  it('falls back to defaults for unknown variant/size (no undefined)', () => {
    const c = buttonClasses({ variant: 'nope', size: 'huge' })
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
    expect(c).not.toContain('undefined')
  })
  it('uses renamed tokens (MOB-UI.1 regression guard)', () => {
    expect(buttonClasses({ variant: 'secondary' })).toContain('border-un1t-border')
  })
})

describe('buttonTextClasses', () => {
  it('white text on primary/danger, dark on secondary', () => {
    expect(buttonTextClasses({ variant: 'primary' })).toContain('text-white')
    expect(buttonTextClasses({ variant: 'danger' })).toContain('text-white')
    expect(buttonTextClasses({ variant: 'secondary' })).toContain('text-un1t-text')
    expect(buttonTextClasses({ variant: 'ghost' })).toContain('text-un1t-subtle')
  })
})

describe('cardClasses', () => {
  it('defaults to md padding', () => {
    expect(cardClasses()).toContain(CARD_PADDING.md)
  })
  it('none padding emits no p- class', () => {
    expect(cardClasses({ padding: 'none' })).not.toMatch(/\bp-\d/)
  })
  it('appends caller className', () => {
    expect(cardClasses({ className: 'mt-4' })).toContain('mt-4')
  })
})
